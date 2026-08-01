/**
 * Voodoo Liquidity Miner — PulseChain
 * Addresses from product HTML (miner + VDO/PLS pairs).
 */
window.VoodooConfig = {
  MINER_ADDRESS: '0xCc5AD08eB08cC946668900176f9eF66341F375c5',
  /** Fallback if Cc5… reads fail — older HTML used this */
  MINER_ADDRESS_LEGACY: '0x1128b5B9c53BdbC93d074Ae8cA4327358C0DD523',
  VDO_ADDRESS: '0x1c5f8e8E84AcC71650F7a627cfA5B24B80f44f00',
  WPLS_ADDRESS: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',
  PAIR_V1: '0x2F2Ac1C1D548c838a1ae54b848dA9d20419a8246',
  PAIR_V2: '0xD26fc3cbE7FC59AC861B1a471a8c52bBf922CE54',
  PULSE_CHAIN_ID: 369,
  PULSECHAIN_NETWORK: {
    chainId: '0x171',
    chainName: 'PulseChain',
    nativeCurrency: { name: 'Pulse', symbol: 'PLS', decimals: 18 },
    rpcUrls: ['https://rpc.pulsechain.com'],
    blockExplorerUrls: ['https://scan.pulsechain.com'],
  },
  RPC_URLS: [
    'https://rpc.pulsechain.com',
    'https://pulsechain.publicnode.com',
    'https://pulsechain-rpc.publicnode.com',
  ],
  PAIR_ABI: [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  ],
  TOKEN_ABI: [
    'function approve(address,uint256) external returns(bool)',
    'function balanceOf(address) external view returns(uint256)',
    'function allowance(address,address) external view returns(uint256)',
  ],
};
