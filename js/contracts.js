window.VoodooContracts = (function () {
  const cfg = () => window.VoodooConfig;

  function rpcUrls() {
    return (cfg().RPC_URLS || []).slice();
  }

  function makeProvider(url) {
    return new ethers.providers.StaticJsonRpcProvider(url, {
      name: 'PulseChain',
      chainId: 369,
    });
  }

  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      Promise.resolve(promise).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(label || `Timed out after ${ms}ms`);
          err.code = 'TIMEOUT';
          reject(err);
        }, ms);
      }),
    ]);
  }

  async function withReadFailover(fn, perRpcMs = 8000) {
    let lastErr;
    for (const url of rpcUrls()) {
      try {
        return await withTimeout(fn(makeProvider(url)), perRpcMs, 'RPC timeout');
      } catch (err) {
        lastErr = err;
        console.warn('[VoodooContracts]', url, err?.message || err);
      }
    }
    throw lastErr || new Error('All RPCs failed');
  }

  async function waitForReceipt(txHash, maxMs = 45_000) {
    if (!txHash) return null;
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      for (const url of rpcUrls()) {
        try {
          const receipt = await withTimeout(
            makeProvider(url).getTransactionReceipt(txHash),
            4000,
            'receipt timeout',
          );
          if (receipt) return receipt;
        } catch {
          /* try next */
        }
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    return null;
  }

  function minerAddress() {
    return cfg().MINER_ADDRESS;
  }

  return {
    makeProvider,
    withTimeout,
    withReadFailover,
    waitForReceipt,
    minerAddress,
    rpcUrls,
  };
})();
