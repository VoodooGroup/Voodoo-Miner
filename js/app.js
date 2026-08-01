/**
 * Voodoo Liquidity Miner dApp
 * Dual wallet (Voodoo + Other) + full mine / stop / claim flow.
 */
(function () {
  const cfg = () => window.VoodooConfig;
  const MINER = () => cfg().MINER_ADDRESS;
  const VDO = () => cfg().VDO_ADDRESS;
  const WPLS = () => cfg().WPLS_ADDRESS;
  const PAIR_V1 = () => cfg().PAIR_V1;
  const PAIR_V2 = () => cfg().PAIR_V2;

  // Full ABI from product HTML (includes pool stats + mine/stop/claim)
  const MINER_ABI = [
    'function claimRewards(uint256 _pid) external',
    'function mine(uint256 _pid, uint256 _amountVDODesired, uint256 _amountVDOMin, uint256 _amountPLSMin, uint256 _deadline) external payable',
    'function pendingRewards(uint256 _pid, address _user) view returns (uint256)',
    'function poolInfo(uint256) view returns (address router, address pair, uint256 annualRewardRate, uint256 totalStakedLP)',
    'function poolLength() view returns (uint256)',
    'function stopMining(uint256 _pid, uint256 _lpAmount, uint256 _amountVDOMin, uint256 _amountPLSMin, uint256 _deadline) external',
    'function userInfo(uint256, address) view returns (uint256 stakedLP, uint256 stakeTime, uint256 rewardRate, uint256 rewardsDebt)',
    'function vdoToken() view returns (address)',
    'function activeMiners() view returns (uint256)',
    'function currentLockedCoins() view returns (uint256)',
    'function currentMiners() view returns (uint256)',
  ];

  let provider = null;
  let signer = null;
  let user = null;
  let miner = null;
  let vdoToken = null;
  let walletListenersReady = false;
  let pendingIsFullStop = false;
  let txBusy = false;
  let txGen = 0; // newer click cancels/supersedes stuck wallet wait
  let busyUnlockTimer = null;
  let infoTimer = null;

  const el = (id) => document.getElementById(id);

  /** Always free UI after cancel / dismiss / timeout (Voodoo often hangs if popup closed) */
  function unlockTx(msg, type) {
    txBusy = false;
    if (busyUnlockTimer) {
      clearTimeout(busyUnlockTimer);
      busyUnlockTimer = null;
    }
    if (msg) status(msg, type || '');
    // Re-enable Mine/Approve based on allowance
    updateMineButtons().catch(() => {});
    updateStopButtons().catch(() => {});
  }

  function armBusyTimeout(gen, label) {
    if (busyUnlockTimer) clearTimeout(busyUnlockTimer);
    busyUnlockTimer = setTimeout(() => {
      if (txBusy && gen === txGen) {
        unlockTx(
          (label || 'Wallet') +
            ' did not respond (closed popup?). Click the button again.',
          'error',
        );
      }
    }, 40_000);
  }

  function isQuietWalletCancel(err) {
    const msg = String(err?.reason || err?.message || err || '').toLowerCase();
    const code = err?.code;
    return (
      code === 4001 ||
      code === 'ACTION_REJECTED' ||
      code === 'TIMEOUT' ||
      code === 'VOODOO_TIMEOUT' ||
      /user rejected|user denied|rejected|cancel|timeout|timed out|no response|did not respond/i.test(
        msg,
      )
    );
  }

  function status(msg, type = '') {
    const s = el('status');
    if (!s) return;
    s.textContent = msg;
    s.className = 'status' + (type ? ' ' + type : '');
  }

  function shortAddress(addr) {
    if (!addr) return '---';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  }

  function setVoodooBtnLabel(address) {
    const btn = el('voodooWalletBtn');
    if (!btn) return;
    btn.textContent = address ? shortAddress(address) : 'Voodoo Wallet';
  }

  function markConnectedUi(kind, address) {
    const connectBtn = el('connectBtn');
    const voodooBtn = el('voodooWalletBtn');
    const label = shortAddress(address);
    if (kind === 'voodoo') {
      if (voodooBtn) {
        voodooBtn.disabled = false;
        voodooBtn.classList.add('is-connected');
        setVoodooBtnLabel(address);
      }
      if (connectBtn) {
        connectBtn.disabled = true;
        connectBtn.classList.remove('is-connected');
        connectBtn.textContent = 'Other';
      }
      return;
    }
    if (connectBtn) {
      connectBtn.disabled = false;
      connectBtn.classList.add('is-connected');
      connectBtn.textContent = label;
    }
    if (voodooBtn) {
      voodooBtn.disabled = true;
      voodooBtn.classList.remove('is-connected');
      setVoodooBtnLabel(null);
    }
  }

  function resetWalletUi() {
    provider = signer = user = miner = vdoToken = null;
    window.VoodooWallet?.clearActiveWallet?.();
    const connectBtn = el('connectBtn');
    const voodooBtn = el('voodooWalletBtn');
    if (connectBtn) {
      connectBtn.disabled = false;
      connectBtn.classList.remove('is-connected');
      connectBtn.textContent = 'Other';
    }
    if (voodooBtn) {
      voodooBtn.disabled = false;
      voodooBtn.classList.remove('is-connected');
      setVoodooBtnLabel(null);
    }
    if (el('addressShort')) el('addressShort').textContent = '---';
    if (el('vdoBalance')) el('vdoBalance').textContent = '0';
    if (el('plsBalance')) el('plsBalance').textContent = '0';
    if (el('pending0')) el('pending0').textContent = '0 VDO (V1)';
    if (el('pending1')) el('pending1').textContent = '0 VDO (V2)';
    ['approveBtn', 'mineBtn', 'stopMiningBtn', 'claimBtn'].forEach((id) => {
      const b = el(id);
      if (!b) return;
      b.disabled = true;
      b.classList.remove('enabled');
    });
    status('Connect your wallet to start mining');
    if (infoTimer) {
      clearInterval(infoTimer);
      infoTimer = null;
    }
  }

  async function withTimeout(p, ms, msg) {
    if (window.VoodooContracts?.withTimeout) {
      return window.VoodooContracts.withTimeout(p, ms, msg || 'Timed out');
    }
    let timer;
    return Promise.race([
      Promise.resolve(p).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(msg || 'Timed out');
          err.code = 'TIMEOUT';
          reject(err);
        }, ms);
      }),
    ]);
  }

  /**
   * Send tx via Voodoo/MetaMask with hard timeout.
   * Closing the extension without Reject often never resolves — we must timeout.
   */
  async function sendAndWait(sendFn, pendingMsg, opts = {}) {
    const walletMs = opts.walletMs || 40_000;
    const receiptMs = opts.receiptMs || 40_000;
    status(pendingMsg || 'Confirm in Voodoo Wallet…');

    let tx;
    try {
      tx = await withTimeout(
        sendFn(),
        walletMs,
        'Wallet did not respond (popup closed?). Click again to retry.',
      );
    } catch (err) {
      // Normalize cancel / dismiss
      if (isQuietWalletCancel(err)) {
        const e = new Error(
          'Cancelled in wallet — click Mine / Approve again when ready.',
        );
        e.code = 'ACTION_REJECTED';
        throw e;
      }
      throw err;
    }

    const hash = tx?.hash || tx;
    if (!hash) {
      throw new Error('No transaction hash — try again.');
    }

    status('Pending on PulseChain…');
    // Never await wallet receipt forever
    if (tx?.wait) tx.wait(1).catch(() => null);

    const receipt = window.VoodooContracts?.waitForReceipt
      ? await window.VoodooContracts.waitForReceipt(hash, receiptMs)
      : null;

    if (receipt) {
      const ok =
        receipt.status === 1 ||
        receipt.status === '0x1' ||
        Number(receipt.status) === 1;
      if (!ok) throw new Error('Transaction reverted');
    }
    // No receipt yet is OK — hash means it was submitted
    return { hash, receipt };
  }

  // ——— Public pool stats (no wallet) — matches product loadPublicData ———
  async function loadPublicData() {
    const urls = cfg().RPC_URLS || [];
    let success = false;
    for (let attempt = 0; attempt < urls.length; attempt++) {
      const url = urls[attempt];
      try {
        const tempProvider = new ethers.providers.JsonRpcProvider(url);
        const minerReadOnly = new ethers.Contract(MINER(), MINER_ABI, tempProvider);

        const pool0 = await minerReadOnly.poolInfo(0);
        const pool1 = await minerReadOnly.poolInfo(1);

        el('apyV1').textContent =
          Number(pool0.annualRewardRate).toFixed(2) + '%';
        el('apyV2').textContent =
          Number(pool1.annualRewardRate).toFixed(2) + '%';
        el('apyText').textContent = Number(pool0.annualRewardRate).toFixed(0);
        el('aboutApy').textContent = Number(pool0.annualRewardRate).toFixed(0);

        const locked = await minerReadOnly.currentLockedCoins();
        el('lockedCoins').textContent = Number(
          ethers.utils.formatUnits(locked, 18),
        ).toLocaleString();

        const miners = await minerReadOnly.currentMiners();
        el('activeMiners').textContent = miners.toString();

        success = true;
        break;
      } catch (e) {
        console.warn('RPC failed', url, e?.message || e);
      }
    }
    if (!success) {
      // one retry with legacy miner address
      try {
        const tempProvider = new ethers.providers.JsonRpcProvider(urls[0]);
        const m2 = new ethers.Contract(
          cfg().MINER_ADDRESS_LEGACY,
          MINER_ABI,
          tempProvider,
        );
        const pool0 = await m2.poolInfo(0);
        const pool1 = await m2.poolInfo(1);
        el('apyV1').textContent =
          Number(pool0.annualRewardRate).toFixed(2) + '%';
        el('apyV2').textContent =
          Number(pool1.annualRewardRate).toFixed(2) + '%';
        el('apyText').textContent = Number(pool0.annualRewardRate).toFixed(0);
        el('aboutApy').textContent = Number(pool0.annualRewardRate).toFixed(0);
        try {
          const locked = await m2.currentLockedCoins();
          el('lockedCoins').textContent = Number(
            ethers.utils.formatUnits(locked, 18),
          ).toLocaleString();
        } catch {
          /* ignore */
        }
        try {
          const miners = await m2.currentMiners();
          el('activeMiners').textContent = miners.toString();
        } catch {
          /* ignore */
        }
        cfg().MINER_ADDRESS = cfg().MINER_ADDRESS_LEGACY;
        success = true;
      } catch {
        /* ignore */
      }
    }
    if (!success) status('Failed to load pool data', 'error');
  }
  const updatePublicStats = loadPublicData;

  async function onWalletConnected(result) {
    provider = result.provider;
    signer = result.signer;
    user = result.userAddress;
    miner = new ethers.Contract(MINER(), MINER_ABI, signer);
    vdoToken = new ethers.Contract(VDO(), cfg().TOKEN_ABI, signer);

    const kind =
      result.walletKind ||
      window.VoodooWallet.getActiveWalletKind() ||
      'injected';
    markConnectedUi(kind, user);
    if (el('addressShort')) el('addressShort').textContent = shortAddress(user);
    status('Connected successfully!', 'success');

    if (!walletListenersReady) {
      walletListenersReady = true;
      window.VoodooWallet.bindListeners(
        async (account) => {
          if (!account) {
            resetWalletUi();
            return;
          }
          if (account.toLowerCase() === (user || '').toLowerCase()) {
            updateInfo().catch(() => {});
            return;
          }
          try {
            const k = window.VoodooWallet.getActiveWalletKind() || 'injected';
            const eth = window.VoodooWallet.getActiveProvider();
            const reconnect = await window.VoodooWallet.connectWithProvider(
              eth,
              k,
            );
            await onWalletConnected(reconnect);
          } catch (e) {
            console.error(e);
            resetWalletUi();
          }
        },
        () => window.location.reload(),
      );
    }

    try {
      window.VoodooWallet.registerVoodooToken?.(result.ethereum)?.catch?.(() => {});
    } catch {
      /* ignore */
    }

    await updateInfo();
    if (infoTimer) clearInterval(infoTimer);
    infoTimer = setInterval(() => updateInfo().catch(() => {}), 12_000);
  }

  /** Fallback: any injected wallet (MetaMask etc.) without RainbowKit */
  async function connectInjectedFallback() {
    if (!window.VoodooWallet) {
      throw new Error('Wallet module not loaded. Hard refresh (Ctrl+F5).');
    }
    if (typeof ethers === 'undefined') {
      throw new Error('ethers.js not loaded. Check internet / CDN.');
    }
    const eth =
      window.VoodooWallet.getMetaMaskProvider?.() ||
      window.ethereum ||
      window.voodooEthereum;
    if (!eth) {
      throw new Error(
        'No browser wallet found. Install Voodoo Wallet or MetaMask.',
      );
    }
    const kind = window.VoodooWallet.isVoodooProvider?.(eth)
      ? 'voodoo'
      : 'injected';
    return window.VoodooWallet.connectWithProvider(eth, kind);
  }

  function bindVoodooWalletButton() {
    const btn = el('voodooWalletBtn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      if (user && window.VoodooWallet?.getActiveWalletKind?.() === 'voodoo') {
        return;
      }
      status('Connecting Voodoo Wallet…');
      try {
        if (!window.VoodooWallet?.connectVoodoo) {
          throw new Error('Wallet module missing — hard refresh (Ctrl+F5)');
        }
        window.VoodooWallet.clearActiveWallet?.();
        let result;
        try {
          result = await window.VoodooWallet.connectVoodoo();
        } catch (e1) {
          // Fallback: try voodoo global / ethereum if detection failed
          console.warn('connectVoodoo failed, trying injected', e1);
          result = await connectInjectedFallback();
        }
        await onWalletConnected(result);
      } catch (err) {
        const quiet =
          err?.code === 4001 ||
          err?.code === 'ACTION_REJECTED' ||
          /reject|cancel|denied/i.test(err?.message || '');
        if (!quiet) {
          status(err?.message || 'Voodoo Wallet connection failed', 'error');
          window.VoodooUI?.alert?.(err?.message || 'Connection failed', {
            title: 'Voodoo Wallet',
            type: 'error',
          });
        } else {
          status('Connection cancelled');
        }
        if (!user) resetWalletUi();
      }
    });
  }

  function bindOtherButton() {
    const btn = el('connectBtn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const kind = window.VoodooWallet?.getActiveWalletKind?.();
      if (user && (kind === 'rainbow' || kind === 'injected')) {
        try {
          await window.VoodooRainbow?.openConnectModal?.({ mode: 'account' });
        } catch {
          /* ignore */
        }
        return;
      }

      status('Connecting wallet…');

      // Prefer RainbowKit modal when ready
      if (window.VoodooRainbow?.ready && window.VoodooRainbow.openConnectModal) {
        try {
          await window.VoodooRainbow.openConnectModal({
            mode: 'connect',
            forceConnect: true,
          });
          window.VoodooWallet?.cancelPendingRainbow?.('restart');
          const result = await window.VoodooWallet.connectOther();
          if (result?.userAddress) {
            await onWalletConnected(result);
            return;
          }
        } catch (err) {
          const quiet =
            err?.code === 4001 ||
            err?.code === 'ACTION_REJECTED' ||
            err?.code === 'TIMEOUT' ||
            /reject|cancel|timeout/i.test(err?.message || '');
          if (quiet) {
            status('Connection cancelled');
            return;
          }
          console.warn('RainbowKit failed, fallback inject', err);
          // fall through to injected
        }
      }

      // Fallback: MetaMask / any injected wallet (works even if RainbowKit slow)
      try {
        const result = await connectInjectedFallback();
        await onWalletConnected(result);
      } catch (err) {
        status(err?.message || 'Connection failed', 'error');
        window.VoodooUI?.alert?.(err?.message || 'Connection failed', {
          title: 'Wallet',
          type: 'error',
        });
      }
    });
  }

  // ——— Mining UI (aligned with your fixed product HTML) ———

  let debounceTimer;
  window.debouncedCalculate = function debouncedCalculate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => calculateOptimalPLS(), 500);
  };

  /** FIXED: better button enabling (from your script) */
  window.updateMineButtons = async function updateMineButtons() {
    if (!user || !vdoToken) return;
    try {
      const allowance = await vdoToken.allowance(user, MINER());
      const bal = await vdoToken.balanceOf(user);
      const hasAllowance = allowance.gte(bal) && bal.gt(0);

      el('approveBtn').disabled = hasAllowance;
      el('approveBtn').classList.toggle('enabled', !hasAllowance);

      el('mineBtn').disabled = !hasAllowance;
      el('mineBtn').classList.toggle('enabled', hasAllowance);
    } catch (e) {
      console.error(e);
    }
  };

  window.updateStopButtons = async function updateStopButtons() {
    if (!user || !miner) return;
    try {
      const pid = +el('stopMiningPool').value;
      const info = await miner.userInfo(pid, user);
      const pending = await miner.pendingRewards(pid, user);

      const canStop = info.stakedLP.gt(0);
      el('stopMiningBtn').disabled = !canStop;
      el('stopMiningBtn').classList.toggle('enabled', canStop);

      const canClaim = pending.gt(0);
      el('claimBtn').disabled = !canClaim;
      el('claimBtn').classList.toggle('enabled', canClaim);
    } catch (e) {
      console.error(e);
    }
  };

  window.approveVDO = async function approveVDO() {
    if (!vdoToken || !user) return status('Connect wallet first', 'error');
    // Second click while stuck → unlock and allow retry
    if (txBusy) {
      txGen += 1;
      unlockTx('Previous request cleared — click Approve again.', 'error');
      return;
    }
    const gen = ++txGen;
    txBusy = true;
    armBusyTimeout(gen, 'Approve');
    try {
      status('Approving VDO (max amount)…');
      await sendAndWait(
        () =>
          vdoToken.approve(MINER(), ethers.constants.MaxUint256, {
            gasLimit: 120000,
          }),
        'Confirm Approve VDO in Voodoo Wallet…',
      );
      if (gen !== txGen) return;
      status('VDO approved! You can now Mine.', 'success');
      await updateMineButtons();
    } catch (e) {
      if (gen !== txGen) return;
      if (isQuietWalletCancel(e)) {
        status(
          e.message || 'Approve cancelled — click Approve again.',
          'error',
        );
      } else {
        status('Approval failed: ' + (e.reason || e.message || e), 'error');
      }
    } finally {
      if (gen === txGen) unlockTx();
    }
  };

  window.fillMaxVDO = async function fillMaxVDO() {
    if (!vdoToken || !user) return status('Connect wallet first', 'error');
    try {
      const bal = await vdoToken.balanceOf(user);
      el('amountVDO').value = ethers.utils.formatUnits(bal, 18);
      debouncedCalculate();
    } catch (e) {
      status('Failed to load balance', 'error');
    }
  };

  async function calculateOptimalPLS() {
    const vdoRaw = el('amountVDO').value;
    if (!vdoRaw || +vdoRaw <= 0) return;
    const pid = el('poolSelect').value;
    const pairAddr = pid === '0' ? PAIR_V1() : PAIR_V2();
    try {
      // Prefer wallet provider when connected, else public RPC
      let pairProvider = provider;
      if (!pairProvider) {
        await window.VoodooContracts.withReadFailover(async (p) => {
          pairProvider = p;
        });
      }
      if (!pairProvider) {
        pairProvider = new ethers.providers.JsonRpcProvider(cfg().RPC_URLS[0]);
      }
      const pair = new ethers.Contract(pairAddr, cfg().PAIR_ABI, pairProvider);
      const [r0, r1] = await pair.getReserves();
      const [vdoRes, plsRes] =
        VDO().toLowerCase() < WPLS().toLowerCase() ? [r0, r1] : [r1, r0];
      if (vdoRes.eq(0)) return status('Pool is empty (no liquidity)', 'error');
      const vdoIn = ethers.utils.parseUnits(vdoRaw, 18);
      const plsOptimal = vdoIn.mul(plsRes).div(vdoRes);
      el('amountPLS').value = ethers.utils.formatEther(plsOptimal);
      status('PLS amount calculated', 'success');
    } catch (e) {
      status('Failed to calculate PLS', 'error');
      console.error(e);
    }
  }
  window.calculateOptimalPLS = calculateOptimalPLS;

  window.mine = async function mine() {
    if (!miner || !user) return status('Connect wallet first', 'error');

    // Stuck after closing Voodoo popup: first re-click clears lock
    if (txBusy) {
      txGen += 1;
      unlockTx(
        'Previous Mine request cleared (wallet closed). Click Mine Now again.',
        'error',
      );
      return;
    }

    const pid = +el('poolSelect').value;
    const vdoRaw = el('amountVDO').value;
    const plsRaw = el('amountPLS').value;
    const slip = +el('slippagePct').value / 100;
    if (!vdoRaw || !plsRaw || +vdoRaw <= 0) {
      return status('Enter VDO amount and calculate PLS first', 'error');
    }

    const gen = ++txGen;
    txBusy = true;
    armBusyTimeout(gen, 'Mine');

    // Visual: keep button clickable for unlock, but show busy state via status
    try {
      const vdoAmt = ethers.utils.parseUnits(vdoRaw, 18);
      const plsAmt = ethers.utils.parseEther(plsRaw);
      const minV = vdoAmt.mul(Math.floor(slip * 10000)).div(10000);
      const minP = plsAmt.mul(Math.floor(slip * 10000)).div(10000);
      const deadline = Math.floor(Date.now() / 1000) + 7200;

      status('Confirm Mine in Voodoo Wallet… (close popup = cancel)');
      await sendAndWait(
        () =>
          miner.mine(pid, vdoAmt, minV, minP, deadline, {
            value: plsAmt,
            gasLimit: 900000,
          }),
        'Confirm Mine in Voodoo Wallet…',
      );

      if (gen !== txGen) return;
      status('Successfully mined! Rewards accruing.', 'success');
      await updateInfo();
      await loadPublicData();
    } catch (e) {
      if (gen !== txGen) return;
      if (isQuietWalletCancel(e)) {
        status(
          e.message ||
            'Mine cancelled — click Mine Now again to retry.',
          'error',
        );
      } else {
        status('Mine failed: ' + (e.reason || e.message || e), 'error');
      }
    } finally {
      if (gen === txGen) unlockTx();
    }
  };

  async function stopMining() {
    if (!miner || !user) return status('Connect wallet first', 'error');
    if (txBusy) {
      txGen += 1;
      unlockTx('Previous request cleared — try Stop Mining again.', 'error');
      return;
    }
    const pid = +el('stopMiningPool').value;
    const lpStr = el('stopMiningAmount').value;
    if (!lpStr || +lpStr <= 0) return status('Enter LP amount', 'error');

    const gen = ++txGen;
    txBusy = true;
    armBusyTimeout(gen, 'Stop Mining');
    try {
      const info = await miner.userInfo(pid, user);
      const inputAmt = ethers.utils.parseUnits(lpStr, 18);
      if (inputAmt.gt(info.stakedLP)) {
        status('Not enough staked LP', 'error');
        return;
      }
      const deadline = Math.floor(Date.now() / 1000) + 7200;
      status('Confirm Stop Mining in Voodoo Wallet…');
      await sendAndWait(
        () =>
          miner.stopMining(pid, inputAmt, 0, 0, deadline, {
            gasLimit: 900000,
          }),
        'Confirm Stop Mining in Voodoo Wallet…',
      );
      if (gen !== txGen) return;
      status('Stopped mining and claimed rewards!', 'success');
      await updateInfo();
      await loadPublicData();
    } catch (e) {
      if (gen !== txGen) return;
      if (isQuietWalletCancel(e)) {
        status('Cancelled — click Stop Mining again to retry.', 'error');
      } else {
        status('Stop Mining failed: ' + (e.reason || e.message || e), 'error');
      }
    } finally {
      if (gen === txGen) unlockTx();
    }
  }

  async function claimRewards() {
    if (!miner || !user) return status('Connect wallet first', 'error');
    if (txBusy) {
      txGen += 1;
      unlockTx('Previous request cleared — try Claim again.', 'error');
      return;
    }
    const pid = +el('stopMiningPool').value;
    const gen = ++txGen;
    txBusy = true;
    armBusyTimeout(gen, 'Claim');
    try {
      status('Confirm Claim in Voodoo Wallet…');
      await sendAndWait(
        () => miner.claimRewards(pid, { gasLimit: 250000 }),
        'Confirm Claim in Voodoo Wallet…',
      );
      if (gen !== txGen) return;
      status('Rewards claimed successfully!', 'success');
      await updateInfo();
    } catch (e) {
      if (gen !== txGen) return;
      if (isQuietWalletCancel(e)) {
        status('Cancelled — click Claim again to retry.', 'error');
      } else {
        status('Claim failed: ' + (e.reason || e.message || e), 'error');
      }
    } finally {
      if (gen === txGen) unlockTx();
    }
  }

  window.fillMaxLPForStop = async function fillMaxLPForStop() {
    if (!miner || !user) return status('Connect wallet first', 'error');
    const pid = +el('stopMiningPool').value;
    try {
      const info = await miner.userInfo(pid, user);
      el('stopMiningAmount').value = ethers.utils.formatUnits(
        info.stakedLP,
        18,
      );
    } catch (e) {
      status('Failed to load staked LP', 'error');
    }
  };

  async function updateInfo() {
    if (!user || !miner || !vdoToken) return;
    try {
      const vdo = await vdoToken.balanceOf(user);
      el('vdoBalance').textContent = Number(
        ethers.utils.formatUnits(vdo, 18),
      ).toLocaleString();

      const pls = await provider.getBalance(user);
      el('plsBalance').textContent = Number(
        ethers.utils.formatEther(pls),
      ).toLocaleString();

      const p0 = await miner.pendingRewards(0, user);
      const p1 = await miner.pendingRewards(1, user);
      el('pending0').textContent =
        Number(ethers.utils.formatUnits(p0, 18)).toLocaleString() +
        ' VDO (V1)';
      el('pending1').textContent =
        Number(ethers.utils.formatUnits(p1, 18)).toLocaleString() +
        ' VDO (V2)';

      await updateMineButtons();
      await updateStopButtons();
    } catch (e) {
      console.error(e);
    }
  }

  window.showCustomConfirm = async function showCustomConfirm(isFullStop) {
    if (!user) return status('Wallet not connected', 'error');
    try {
      const pid = +el('stopMiningPool').value;
      const pending = await miner.pendingRewards(pid, user);
      const formatted = Number(
        ethers.utils.formatUnits(pending, 18),
      ).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      });
      let msg = `Pending rewards: ${formatted} VDO\n\n`;
      msg += isFullStop
        ? 'This will unstake your LP and claim all rewards.'
        : 'This will claim rewards only (LP stays staked).';
      el('modalMessage').textContent = msg;
      pendingIsFullStop = isFullStop;
      el('modalOverlay').style.display = 'flex';
    } catch (e) {
      status('Error loading rewards', 'error');
    }
  };

  window.closeModal = function closeModal() {
    el('modalOverlay').style.display = 'none';
  };

  window.handleConfirmYes = function handleConfirmYes() {
    closeModal();
    if (pendingIsFullStop) stopMining();
    else claimRewards();
  };

  function init() {
    bindVoodooWalletButton();
    bindOtherButton();
    el('modalOverlay')?.addEventListener('click', (e) => {
      if (e.target === el('modalOverlay')) closeModal();
    });
    // Live APY / locked / miners without wallet (product loadPublicData)
    loadPublicData();
    setInterval(() => loadPublicData().catch(() => {}), 30_000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
