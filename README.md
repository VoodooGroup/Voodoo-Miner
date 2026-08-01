# Voodoo Miner (Liquidity Miner)

PulseChain dApp for **VDO + PLS** liquidity mining on PulseX V1 / V2.

## Path

`C:\Users\ReMarkt\VoodooMiner`

## Run locally

Double-click **`START.bat`** or:

```bat
node server.js
```

Open **http://127.0.0.1:8080/**

## Features

- Dual wallet: **Voodoo Wallet** + **Other** (RainbowKit)
- Pool overview: APY V1/V2, locked VDO, active miners (public RPC)
- Mine: VDO amount → auto PLS from pair reserves → Approve → Mine
- Stop mining + claim / claim only
- Confirm modal for stop/claim

## Contract

- Miner: `0xCc5AD08eB08cC946668900176f9eF66341F375c5`
- VDO: `0x1c5f8e8E84AcC71650F7a627cfA5B24B80f44f00`

## Structure

```
index.html
css/miner.css
js/config.js | contracts.js | wallet.js | ui.js | app.js | rainbow-bridge.*
server.js / START.bat
```
