import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount, getMint } from "@solana/spl-token";
import { Metaplex } from "@metaplex-foundation/js";
import { fetchTokenData } from "@/utils/solanaData";
import stocksData from '@/data/stocks.json';

interface TokenInfo {
  mint: string;
  tokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number;
    uiAmountString: string;
  };
}

interface TokenAccount {
  mint: string;
  balance: number;
  decimals: number;
  symbol?: string;
  name?: string;
  price?: number;
  logoURI?: string;
}

interface WalletData {
  balance: number;
  tokens: TokenAccount[];
  timestamp: number;
}

// Local helper function to fetch token metadata
async function fetchTokenMetadata(mint: string, connection: Connection) {
  try {
    // Try Metaplex metadata first
    const metaplex = Metaplex.make(connection);
    try {
      const nft = await metaplex.nfts().findByMint({ mintAddress: new PublicKey(mint) });
      if (nft.name && nft.symbol) {
        return {
          symbol: nft.symbol,
          name: nft.name,
          logoURI: nft.json?.image || ''
        };
      }
    } catch (metadataError) {
      // Silently continue to fallback
    }

    // Fallback to Birdeye API for metadata
    try {
      const response = await fetch(`/api/birdeye?addresses=${mint}`);
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.data[mint]) {
          const tokenInfo = data.data[mint];
          return {
            symbol: tokenInfo.symbol || 'UNKNOWN',
            name: tokenInfo.name || 'Unknown Token',
            logoURI: tokenInfo.logoURI || ''
          };
        }
      }
    } catch (birdeyeError) {
      // Silently continue to fallback
    }

    // Final fallback
    return {
      symbol: 'UNKNOWN',
      name: 'Unknown Token',
      logoURI: ''
    };
  } catch (error) {
    return {
      symbol: 'UNKNOWN',
      name: 'Unknown Token',
      logoURI: ''
    };
  }
}

// Local helper function to fetch token prices
async function fetchTokenPrices(tokenMints: string[]) {
  try {
    const tokenPrices: { [key: string]: number } = {};
    
    // Fetch prices using the centralized function
    for (const mint of tokenMints) {
      try {
        const tokenData = await fetchTokenData(mint);
        tokenPrices[mint] = tokenData?.price || 0;
      } catch (error) {
        tokenPrices[mint] = 0;
      }
    }
    
    return tokenPrices;
  } catch (error) {
    // Return empty prices object on error
    const emptyPrices: { [key: string]: number } = {};
    tokenMints.forEach(mint => {
      emptyPrices[mint] = 0;
    });
    return emptyPrices;
  }
}

/**
 * Prefetch wallet data in the background and cache it
 * This function runs silently and doesn't throw errors to avoid disrupting the main flow
 */
export async function prefetchWalletData(walletAddress: string): Promise<void> {
  try {
    console.log('🚀 Starting wallet prefetch for:', walletAddress);
    // Check if we already have recent cached data (within 5 minutes)
    if (typeof window !== 'undefined') {
      const cached = localStorage.getItem(`wallet_cache_${walletAddress}`);
      if (cached) {
        const cachedData = JSON.parse(cached);
        const isRecent = Date.now() - cachedData.timestamp < 5 * 60 * 1000; // 5 minutes
        if (isRecent) {
          console.log('⏭️ Skipping prefetch - recent cache exists:', {
            cacheAge: (Date.now() - cachedData.timestamp) / 1000
          });
          return; // Skip prefetch if we have recent data
        }
      }
    }
    console.log('📥 No recent cache found, proceeding with prefetch...');

    const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    if (!rpcUrl) {
      return;
    }

    const connection = new Connection(rpcUrl);
    const publicKey = new PublicKey(walletAddress);

    // Fetch SOL balance
    const solBalance = await connection.getBalance(publicKey);
    const balance = solBalance / LAMPORTS_PER_SOL;

    // Fetch token accounts
    let tokenInfos: TokenInfo[] = [];
    const programIds = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

    for (const programId of programIds) {
      try {
        // Try parsed method first
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          publicKey,
          { programId }
        );
        
        if (tokenAccounts.value.length > 0) {
          const parsedInfos = tokenAccounts.value.map(acc => acc.account.data.parsed.info as TokenInfo);
          tokenInfos = [...tokenInfos, ...parsedInfos];
        } else {
          // Fallback to raw method
          const rawAccounts = await connection.getTokenAccountsByOwner(
            publicKey,
            { programId }
          );
          
          for (const rawAccount of rawAccounts.value) {
            try {
              const accountInfo = await getAccount(connection, rawAccount.pubkey, undefined, programId);
              if (accountInfo.amount > 0) {
                const mintInfo = await getMint(connection, accountInfo.mint, undefined, programId);
                const decimals = mintInfo.decimals;
                const amountStr = accountInfo.amount.toString();
                const uiAmount = Number(accountInfo.amount) / Math.pow(10, decimals);
                const tokenAmount = {
                  amount: amountStr,
                  decimals,
                  uiAmount,
                  uiAmountString: uiAmount.toString()
                };
                const info: TokenInfo = {
                  mint: accountInfo.mint.toString(),
                  tokenAmount,
                };
                tokenInfos.push(info);
              }
            } catch (parseError) {
              // Silently continue on parse errors
              continue;
            }
          }
        }
      } catch (error) {
        // Silently continue on program errors
        continue;
      }
    }

    // Remove duplicates by mint
    const processedTokens = tokenInfos.filter((token, index, self) =>
      index === self.findIndex((t) => t.mint === token.mint)
    );

    // Create token data with metadata
    const tokenData: TokenAccount[] = [];
    const stockMap = new Map(stocksData.xStocks.map(stock => [stock.solanaAddress, stock]));
    
    for (const info of processedTokens) {
      const balance = info.tokenAmount.uiAmount;
      let metadata = await fetchTokenMetadata(info.mint, connection);
      
      const stockInfo = stockMap.get(info.mint);
      if (stockInfo) {
        metadata = {
          symbol: stockInfo.symbol,
          name: stockInfo.name,
          logoURI: stockInfo.logoUrl
        };
      }
      
      tokenData.push({
        mint: info.mint,
        balance: balance,
        decimals: info.tokenAmount.decimals,
        symbol: metadata.symbol,
        name: metadata.name,
        logoURI: metadata.logoURI
      });
    }

    // Fetch prices for all tokens
    const tokenMints = tokenData.map(token => token.mint);
    // Always include SOL mint for price
    if (!tokenMints.includes('So11111111111111111111111111111111111111112')) {
      tokenMints.push('So11111111111111111111111111111111111111112');
    }
    
    const tokenPrices = await fetchTokenPrices(tokenMints);

    // Add prices to token data
    const tokensWithPrices = tokenData.map(token => ({
      ...token,
      price: tokenPrices[token.mint] || 0
    }));

    // Cache the prefetched data
    if (typeof window !== 'undefined') {
      const walletCacheData: WalletData = {
        balance,
        tokens: tokensWithPrices,
        timestamp: Date.now()
      };
      localStorage.setItem(`wallet_cache_${walletAddress}`, JSON.stringify(walletCacheData));
      console.log('💾 Wallet data prefetched and cached successfully:', {
        address: walletAddress,
        tokenCount: tokensWithPrices.length,
        balance: balance
      });
    }
  } catch (error) {
    // Silently fail - prefetching should not disrupt the main application flow
    console.warn('❌ Wallet prefetch failed:', error);
    return;
  }
}

/**
 * Get cached wallet data if available and recent
 */
export function getCachedWalletData(walletAddress: string): WalletData | null {
  if (typeof window === 'undefined') {
    return null;
  }
  
  try {
    const cached = localStorage.getItem(`wallet_cache_${walletAddress}`);
    if (!cached) {
      return null;
    }
    
    const cachedData = JSON.parse(cached) as WalletData;
    const isValid = Date.now() - cachedData.timestamp < 10 * 60 * 1000; // 10 minutes
    
    return isValid ? cachedData : null;
  } catch (error) {
    return null;
  }
}