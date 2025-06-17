const { Web3 } = require('web3');
const fs = require('fs');
const colors = require('colors');

// Configuration
const CONFIG = {
  rpcUrl: 'https://evmrpc-testnet.0g.ai',
  swapRouterAddress: '0xd86b764618c6e3c078845be3c3fce50ce9535da7',
  gasMultiplier: 1.2,
  swapPercentage: {
    min: 0.05,
    max: 0.10 // Instead of 0.05 + 0.05 random, easier to control
  },
  delayBetweenMints: 2000, // ms
  claimInterval: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
  privateKeyFile: 'privatekey.txt'
};

const web3 = new Web3(CONFIG.rpcUrl);

// Simplified ABIs
const ABIs = {
  mint: [
    {
      'inputs': [{ 'internalType': 'address', 'name': '', 'type': 'address' }],
      'name': 'lastClaimed',
      'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
      'stateMutability': 'view',
      'type': 'function'
    },
    {
      'inputs': [],
      'name': 'mint',
      'outputs': [],
      'stateMutability': 'nonpayable',
      'type': 'function'
    }
  ],
  erc20: [
    {
      'inputs': [
        { 'internalType': 'address', 'name': 'spender', 'type': 'address' },
        { 'internalType': 'uint256', 'name': 'amount', 'type': 'uint256' }
      ],
      'name': 'approve',
      'outputs': [{ 'internalType': 'bool', 'name': '', 'type': 'bool' }],
      'stateMutability': 'nonpayable',
      'type': 'function'
    },
    {
      'inputs': [{ 'internalType': 'address', 'name': '', 'type': 'address' }],
      'name': 'balanceOf',
      'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
      'stateMutability': 'view',
      'type': 'function'
    }
  ],
  router: [
    {
      'inputs': [
        {
          'components': [
            { 'internalType': 'address', 'name': 'tokenIn', 'type': 'address' },
            { 'internalType': 'address', 'name': 'tokenOut', 'type': 'address' },
            { 'internalType': 'uint24', 'name': 'fee', 'type': 'uint24' },
            { 'internalType': 'address', 'name': 'recipient', 'type': 'address' },
            { 'internalType': 'uint256', 'name': 'deadline', 'type': 'uint256' },
            { 'internalType': 'uint256', 'name': 'amountIn', 'type': 'uint256' },
            { 'internalType': 'uint256', 'name': 'amountOutMinimum', 'type': 'uint256' },
            { 'internalType': 'uint160', 'name': 'sqrtPriceLimitX96', 'type': 'uint160' }
          ],
          'internalType': 'struct ISwapRouter.ExactInputSingleParams',
          'name': 'params',
          'type': 'tuple'
        }
      ],
      'name': 'exactInputSingle',
      'outputs': [{ 'internalType': 'uint256', 'name': 'amountOut', 'type': 'uint256' }],
      'stateMutability': 'payable',
      'type': 'function'
    }
  ]
};

// Token contracts and token symbols
const TOKENS = {
  Ethereum: {
    address: '0x0fE9B43625fA7EdD663aDcEC0728DD635e4AbF7c',
    symbol: 'ETH'
  },
  Bitcoin: {
    address: '0x36f6414FF1df609214dDAbA71c84f18bcf00F67d',
    symbol: 'BTC'
  },
  Tether: {
    address: '0x3ec8a8705be1d5ca90066b37ba62c4183b024ebf',
    symbol: 'USDT'
  }
};

// Colorful log function
function log(msg, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const icons = {
    success: '✓',
    custom: '*',
    error: '✗',
    warning: '!',
    info: 'ℹ'
  };
  
  const icon = icons[type] || icons.info;
  const coloredMsg = (() => {
    switch(type) {
      case 'success': return `[${timestamp}] [${icon}] ${msg}`.green;
      case 'custom': return `[${timestamp}] [${icon}] ${msg}`.magenta;
      case 'error': return `[${timestamp}] [${icon}] ${msg}`.red;
      case 'warning': return `[${timestamp}] [${icon}] ${msg}`.yellow;
      default: return `[${timestamp}] [${icon}] ${msg}`.blue;
    }
  })();
  
  console.log(coloredMsg);
}

// Helpers
const utils = {
  // Create account from private key and automatically add to wallet
  createAccount: (privateKey) => {
    const account = web3.eth.accounts.privateKeyToAccount(privateKey);
    web3.eth.accounts.wallet.add(account);
    return account;
  },
  
  // Get gas price with multiplier
  getGasPrice: async () => {
    const gasPrice = await web3.eth.getGasPrice();
    return BigInt(Math.floor(Number(gasPrice) * CONFIG.gasMultiplier));
  },
  
  // Get current nonce
  getNonce: (address) => web3.eth.getTransactionCount(address, 'pending'),
  
  // Calculate random amount in swapPercentage range
  calculateSwapAmount: (balance) => {
    const { min, max } = CONFIG.swapPercentage;
    const percentage = min + Math.random() * (max - min);
    return BigInt(Math.floor(Number(balance) * percentage));
  },
  
  // Wait for a period of time
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms))
};

// Read private keys from file
function readPrivateKeys() {
  try {
    const data = fs.readFileSync(CONFIG.privateKeyFile, 'utf8');
    return data
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter(key => key.trim() !== '');
  } catch (err) {
    log(`Error reading file ${CONFIG.privateKeyFile}: ${err.message}`, 'error');
    return [];
  }
}

// Check claim eligibility
async function canClaimNow(contract, address) {
  try {
    const lastClaimedTimestamp = await contract.methods.lastClaimed(address).call();
    const lastClaimedTimestampNumber = Number(lastClaimedTimestamp);
    
    // If lastClaimed is 0, this is the first claim
    if (lastClaimedTimestampNumber === 0) {
      log("This is the first claim.", 'custom');
      return true;
    }
    
    const lastClaimedDate = new Date(lastClaimedTimestampNumber * 1000);
    const currentTime = Date.now();
    const timeSinceLastClaim = currentTime - (lastClaimedTimestampNumber * 1000);
    const hoursSinceLastClaim = timeSinceLastClaim / (1000 * 60 * 60);
    const canClaim = hoursSinceLastClaim >= 24;

    log(`Last claim: ${lastClaimedDate.toLocaleString()} | Can claim now: ${canClaim}`);

    if (!canClaim) {
      const nextClaimTime = new Date(lastClaimedDate.getTime() + CONFIG.claimInterval);
      log(`Next claim time: ${nextClaimTime.toLocaleString()}`, 'warning');
    }
    
    return canClaim;
  } catch (error) {
    log(`Error checking eligibility to claim: ${error.message}`, 'error');
    // If there's an "execution reverted" error, it might be the first claim
    if (error.message.includes("execution reverted")) {
      log("There was an error but it might be the first claim, trying to claim.", 'custom');
      return true;
    }
    return false;
  }
}

// Approve token for router
async function approveToken(tokenAddress, amount, account, privateKey) {
  const tokenContract = new web3.eth.Contract(ABIs.erc20, tokenAddress);
  
  try {
    const nonce = await utils.getNonce(account.address);
    const gasPrice = await utils.getGasPrice();

    const tx = {
      from: account.address,
      to: tokenAddress,
      gas: 100000,
      gasPrice,
      data: tokenContract.methods.approve(CONFIG.swapRouterAddress, amount).encodeABI(),
      nonce,
    };

    const signedTx = await web3.eth.accounts.signTransaction(tx, privateKey);
    const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    
    const token = Object.entries(TOKENS).find(([_, data]) => data.address === tokenAddress)?.[0] || 'Unknown';
    log(`Approved ${web3.utils.fromWei(amount.toString(), 'ether')} ${token}. Tx Hash: ${receipt.transactionHash}`, 'success');
    return receipt;
  } catch (error) {
    log(`Error approving token ${tokenAddress}: ${error.message}`, 'error');
    throw error;
  }
}

// Swap tokens
async function swapTokens(tokenIn, tokenOut, amountIn, account, privateKey) {
  const routerContract = new web3.eth.Contract(ABIs.router, CONFIG.swapRouterAddress);
  
  try {
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes
    const nonce = await utils.getNonce(account.address);
    const gasPrice = await utils.getGasPrice();

    const params = {
      tokenIn,
      tokenOut,
      fee: 3000,
      recipient: account.address,
      deadline,
      amountIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    };

    const tx = {
      from: account.address,
      to: CONFIG.swapRouterAddress,
      gas: 300000,
      gasPrice,
      data: routerContract.methods.exactInputSingle(params).encodeABI(),
      nonce,
    };

    const signedTx = await web3.eth.accounts.signTransaction(tx, privateKey);
    const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    
    // Display token names instead of addresses
    const tokenInName = Object.entries(TOKENS).find(([_, data]) => data.address === tokenIn)?.[0] || 'Unknown';
    const tokenOutName = Object.entries(TOKENS).find(([_, data]) => data.address === tokenOut)?.[0] || 'Unknown';
    
    log(`Swapped ${web3.utils.fromWei(amountIn.toString(), 'ether')} ${tokenInName} to ${tokenOutName}. Tx Hash: ${receipt.transactionHash}`, 'success');
    return receipt;
  } catch (error) {
    log(`Error swapping token: ${error.message}`, 'error');
    throw error;
  }
}

// Mint token from contract
async function mintFromContract(privateKey, tokenData) {
  const { address: contractAddress, symbol } = tokenData;
  let account;
  
  try {
    account = utils.createAccount(privateKey);
    
    const balance = await web3.eth.getBalance(account.address);
    log(`Wallet balance ${account.address}: ${web3.utils.fromWei(balance, 'ether')} 0G`);
    
    const contract = new web3.eth.Contract(ABIs.mint, contractAddress);
    const eligibleToClaim = await canClaimNow(contract, account.address);
    
    if (!eligibleToClaim) {
      log(`Cannot claim ${symbol} right now. Please wait until the next claim time.`, 'warning');
      return false;
    }
    
    log(`Starting to mint ${symbol} token...`, 'custom');
    const nonce = await utils.getNonce(account.address);
    const gasPrice = await utils.getGasPrice();

    const mintTx = {
      from: account.address,
      to: contractAddress,
      gas: 500000,
      gasPrice,
      data: contract.methods.mint().encodeABI(),
      nonce,
    };
    
    const signedMintTx = await web3.eth.accounts.signTransaction(mintTx, privateKey);
    const receipt = await web3.eth.sendSignedTransaction(signedMintTx.rawTransaction);
    log(`${symbol} Mint successful for wallet ${account.address}. Tx Hash: ${receipt.transactionHash}`, 'success');
    return true;

  } catch (error) {
    log(`Mint token ${symbol} failed for wallet ${account?.address || 'unknown address'}: ${error.message}`, 'error');
    return false;
  } finally {
    web3.eth.accounts.wallet.clear();
  }
}

// Check and swap tokens
async function checkAndSwapTokens(privateKey) {
  let account;
  try {
    account = utils.createAccount(privateKey);
    log(`Checking balance and preparing to swap for wallet ${account.address}`, 'custom');

    // Create contract instances
    const tokenContracts = Object.entries(TOKENS).reduce((acc, [token, data]) => {
      acc[token] = new web3.eth.Contract(ABIs.erc20, data.address);
      return acc;
    }, {});

    // Get balances of all tokens
    const balances = {};
    for (const [token, contract] of Object.entries(tokenContracts)) {
      const balance = await contract.methods.balanceOf(account.address).call();
      balances[token] = balance;
      log(`${token} Balance: ${web3.utils.fromWei(balance, 'ether')} ${TOKENS[token].symbol}`);
    }

    // Swap USDT to BTC and ETH
    if (Number(balances.Tether) > 0) {
      const usdtToBtc = utils.calculateSwapAmount(balances.Tether);
      const usdtToEth = utils.calculateSwapAmount(balances.Tether);

      const swapPairs = [
        { from: 'Tether', to: 'Bitcoin', amount: usdtToBtc },
        { from: 'Tether', to: 'Ethereum', amount: usdtToEth }
      ];

      // Perform swaps
      for (const pair of swapPairs) {
        if (pair.amount > 0) {
          log(`Swapping ${web3.utils.fromWei(pair.amount.toString(), 'ether')} ${TOKENS[pair.from].symbol} to ${TOKENS[pair.to].symbol}...`, 'custom');
          try {
            await approveToken(TOKENS[pair.from].address, pair.amount, account, privateKey);
            await swapTokens(TOKENS[pair.from].address, TOKENS[pair.to].address, pair.amount, account, privateKey);
            await utils.sleep(1000); // Wait 1 second between swaps
          } catch (err) {
            log(`Error swapping ${pair.from} to ${pair.to}: ${err.message}`, 'error');
          }
        }
      }
    }

    // Update new balances
    for (const [token, contract] of Object.entries(tokenContracts)) {
      balances[token] = await contract.methods.balanceOf(account.address).call();
    }

    // Swap BTC and ETH to USDT
    const tokenToUsdtSwaps = [
      { from: 'Bitcoin', amount: utils.calculateSwapAmount(balances.Bitcoin) },
      { from: 'Ethereum', amount: utils.calculateSwapAmount(balances.Ethereum) }
    ];

    for (const swap of tokenToUsdtSwaps) {
      if (Number(balances[swap.from]) > 0 && swap.amount > 0) {
        log(`Swapping ${web3.utils.fromWei(swap.amount.toString(), 'ether')} ${TOKENS[swap.from].symbol} to USDT...`, 'custom');
        try {
          await approveToken(TOKENS[swap.from].address, swap.amount, account, privateKey);
          await swapTokens(TOKENS[swap.from].address, TOKENS.Tether.address, swap.amount, account, privateKey);
          await utils.sleep(1000); // Wait 1 second between swaps
        } catch (err) {
          log(`Error swapping ${swap.from} to USDT: ${err.message}`, 'error');
        }
      }
    }

    // Update new balances
    for (const [token, contract] of Object.entries(tokenContracts)) {
      balances[token] = await contract.methods.balanceOf(account.address).call();
    }

    return balances;
  } catch (error) {
    log(`Error in checkAndSwapTokens for ${account?.address || 'unknown address'}: ${error.message}`, 'error');
    throw error;
  } finally {
    web3.eth.accounts.wallet.clear();
  }
}

// Main function
async function main() {
  const privateKeys = readPrivateKeys();
  let transactionCount = 0;
  const MAX_TRANSACTIONS = 100;

  while (transactionCount < MAX_TRANSACTIONS) {
    for (const privateKey of privateKeys) {
      try {
        log(`Transaction ${transactionCount + 1}/${MAX_TRANSACTIONS}`, 'info');
        
        // Create account
        const account = utils.createAccount(privateKey);
        
        // Check and swap tokens
        const balances = await checkAndSwapTokens(privateKey);
        // Convert balances to human-readable format
        const readableBalances = {};
        for (const [token, balance] of Object.entries(balances)) {
          readableBalances[token] = web3.utils.fromWei(balance.toString(), 'ether');
        }
        log(`Balances after swapping: ${JSON.stringify(readableBalances)}`, 'custom');
        
        transactionCount++;
        if (transactionCount >= MAX_TRANSACTIONS) {
          log('Reached maximum number of transactions (100)', 'success');
          return;
        }

        // Add delay between transactions
        await utils.sleep(2000); // 2 seconds delay
      } catch (error) {
        log(`Error processing private key ${privateKey}: ${error.message}`, 'error');
        // Continue with next transaction even if there's an error
        transactionCount++;
        if (transactionCount >= MAX_TRANSACTIONS) {
          log('Reached maximum number of transactions (100)', 'success');
          return;
        }
      }
    }
  }
}

// Run the main function
main().catch(error => {
  log(`Program error: ${error.message}`, 'error');
  process.exit(1);
});