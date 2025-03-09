import { getSchnorrAccount } from '@aztec/accounts/schnorr';
import type { InitialAccountData } from '@aztec/accounts/testing';
import type { AztecNodeService } from '@aztec/aztec-node';
import { Fr, GrumpkinScalar, type Logger, TxStatus, type Wallet, sleep } from '@aztec/aztec.js';
import { times } from '@aztec/foundation/collection';
import { createPXEService, getPXEServiceConfig as getRpcConfig } from '@aztec/pxe';
import type { PXEService } from '@aztec/pxe';

import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { shouldCollectMetrics } from '../fixtures/fixtures.js';
import { createNodes } from '../fixtures/setup_p2p_test.js';
import { P2PNetworkTest, SHORTENED_BLOCK_TIME_CONFIG, WAIT_FOR_TX_TIMEOUT } from './p2p_network.js';
import { createPXEServiceAndSubmitTransactions } from './shared.js';

// process.env.PXE_PROVER_ENABLED = 'true';

const NUM_NODES = 2;
const NUM_VALID_TXS = 1;
const NUM_INVALID_TXS = 50;
const BOOT_NODE_UDP_PORT = 40600;

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ddos-'));

jest.setTimeout(1000 * 60 * 10);

describe('e2e_p2p_ddos', () => {
  let t: P2PNetworkTest;
  let nodes: AztecNodeService[];

  beforeEach(async () => {
    t = await P2PNetworkTest.create({
      testName: 'e2e_p2p_ddos',
      numberOfNodes: NUM_NODES,
      basePort: BOOT_NODE_UDP_PORT,
      metricsPort: shouldCollectMetrics(),
      initialConfig: {
        ...SHORTENED_BLOCK_TIME_CONFIG,
        // realProofs: true,
      },
    });

    await t.setupAccount();
    await t.applyBaseSnapshots();
    await t.setup();
    await t.removeInitialNode();
  });

  afterEach(async () => {
    await t.stopNodes(nodes);
    await t.teardown();
    for (let i = 0; i < NUM_NODES; i++) {
      fs.rmSync(`${DATA_DIR}-${i}`, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('should prevent invalid txs from causing ddos attacks', async () => {
    // create the bootstrap node for the network
    if (!t.bootstrapNodeEnr) {
      throw new Error('Bootstrap node ENR is not available');
    }

    t.ctx.aztecNodeConfig.validatorReexecute = true;

    t.logger.info('Creating nodes');
    nodes = await createNodes(
      t.ctx.aztecNodeConfig,
      t.ctx.dateProvider,
      t.bootstrapNodeEnr,
      NUM_NODES,
      BOOT_NODE_UDP_PORT,
      t.prefilledPublicData,
      DATA_DIR,
      // To collect metrics - run in aztec-packages `docker compose --profile metrics up` and set COLLECT_METRICS=true
      shouldCollectMetrics(),
    );

    // wait a bit for peers to discover each other
    await sleep(4000);

    // TODO: should I be building/proving the txs like in the e2e_prover test? yes (sean/phil)
    // TODO: generate a valid tx with proof through pxe (full.test.ts) and then alter a bit on the proof to make it invalid for invalid txs
    t.logger.info('Submitting invalid transactions');
    await createPXEServiceAndSubmitInvalidTransactions(t.logger, nodes[0], NUM_INVALID_TXS, t.fundedAccount);

    t.logger.info('Submitting valid transactions');
    const validTxsContext = await createPXEServiceAndSubmitTransactions(
      t.logger,
      nodes[0],
      NUM_VALID_TXS,
      t.fundedAccount,
    );

    t.logger.info('Waiting for valid transactions to be mined');
    // now ensure that all valid txs were successfully mined
    await Promise.all(
      validTxsContext.txs.map(async (tx, i) => {
        t.logger.info(`Waiting for tx ${i}: ${await tx.getTxHash()} to be mined`);
        return tx.wait({ timeout: WAIT_FOR_TX_TIMEOUT });
      }),
    );
    t.logger.info('All valid transactions mined');
  });
});

const createPXEServiceAndSubmitInvalidTransactions = async (
  logger: Logger,
  node: AztecNodeService,
  numTxs: number,
  fundedAccount: InitialAccountData,
) => {
  const rpcConfig = getRpcConfig();
  const pxeService = await createPXEService(node, rpcConfig, true);

  const account = await getSchnorrAccount(
    pxeService,
    fundedAccount.secret,
    // TODO: is altering the signing key a good way to create invalid transactions?
    GrumpkinScalar.random(),
    fundedAccount.salt,
  );
  await account.register();
  const wallet = await account.getWallet();

  await submitInvalidTxsTo(pxeService, numTxs, wallet, logger);
};

// submits a set of invalid transactions to the provided Private eXecution Environment (PXE)
const submitInvalidTxsTo = async (pxe: PXEService, numTxs: number, wallet: Wallet, logger: Logger) => {
  await Promise.all(
    times(numTxs, async () => {
      const accountManager = await getSchnorrAccount(pxe, Fr.random(), GrumpkinScalar.random(), Fr.random());
      const tx = accountManager.deploy({ deployWallet: wallet });
      const txHash = await tx.getTxHash();

      logger.info(`Invalid tx sent with hash ${txHash}`);
      expect((await tx.getReceipt()).status).toBe(TxStatus.DROPPED);
      logger.info(`Tx ${txHash} dropped`);
    }),
  );
};
