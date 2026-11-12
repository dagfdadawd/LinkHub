/**
 * verifier 调试探针（只读）：检查 packages/server/src/config.ts 在「非测试进程」下是否
 * 成功加载 unimsg-connector/.env 的真实凭据（只输出布尔值，绝不输出值本身）。
 *
 * 用法（仓库根）：node --import tsx docs/qa/verification/tools/debug-config-env.ts
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../../../unimsg-connector/packages/server/src/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const monorepo = resolve(repoRoot, 'unimsg-connector');
const candidates = [
  resolve(monorepo, '.env'),
  resolve(here, '../../../../unimsg-connector/.env'),
  resolve(process.cwd(), '.env'),
];
console.log(
  JSON.stringify(
    {
      cwd: process.cwd(),
      importMetaHere: here,
      candidates: candidates.map((p) => ({ path: p === resolve(monorepo, '.env') ? '<monorepo>/.env' : p, exists: existsSync(p) })),
      fromProcessEnv: {
        feishuAppId: Boolean(process.env.FEISHU_APP_ID),
        feishuAppSecret: Boolean(process.env.FEISHU_APP_SECRET),
        nodeTestContext: Boolean(process.env.NODE_TEST_CONTEXT),
      },
      fromConfig: {
        feishuAppId: Boolean(config.platforms.feishu.appId),
        feishuAppSecret: Boolean(config.platforms.feishu.appSecret),
        feishuVerifyToken: Boolean(config.platforms.feishu.verifyToken),
        feishuMode: config.runtime.feishu.mode,
        dingtalkClientId: Boolean(config.platforms.dingtalk.appKey),
        mailAccountCount: config.mail.accounts.length,
      },
      identityDefaults: {
        feishuPolicy: config.identity.feishu.policy,
        feishuReceive: config.identity.feishu.receive,
        feishuPollMs: config.identity.feishu.pollMs,
        feishuChatLimit: config.identity.feishu.chatLimit,
        feishuBackfillHours: config.identity.feishu.backfillHours,
        dingtalkPolicy: config.identity.dingtalk.policy,
        dingtalkReceive: config.identity.dingtalk.receive,
        dingtalkEventKinds: config.identity.dingtalk.eventKinds,
        dingtalkBin: config.identity.dingtalk.bin,
        dingtalkAuthTimeoutMs: config.identity.dingtalk.authTimeoutMs,
        dingtalkSendTimeoutMs: config.identity.dingtalk.sendTimeoutMs,
      },
    },
    null,
    2,
  ),
);