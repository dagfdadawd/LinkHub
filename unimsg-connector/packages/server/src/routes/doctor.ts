/**
 * GET /api/doctor：把 `pnpm run doctor` 的自检能力暴露为只读 HTTP 接口（UX 评审 P1-9）。
 * 供账号页「一键自检」调用，让用户不进终端也能拿到与 CLI 同口径的 PASS/FAIL/SKIP 结论。
 *
 * 与既有两个入口的分工（三者共用 doctor/probes.ts 同一套探针，绝不另起第二套逻辑）：
 *  - CLI `pnpm run doctor`（src/doctor.ts）：证据最硬，支持 --platform 过滤与 --out 落盘取证；
 *  - GET /api/doctor/summary（routes/diagnostics.ts）：只读进程内状态，秒回、绝不出网；
 *  - 本接口：实时跑一轮探针（换 token / IMAP SEARCH 基线 / SMTP 登录自检，全部只读，
 *    绝不发送业务消息），真实模式下最慢可到 25s+（邮箱探针），前端要按慢接口处理。
 *
 * 安全约定：
 *  - 鉴权与其它 /api 业务路由一致：挂载点统一加 apiAuth（见 index.ts / 单测里的挂载方式）；
 *  - 探针输入 ProbeInput 里的密钥只在服务端内存中流转，绝不进响应；
 *    detail/hint 走与 CLI JSON 报告同一套邮箱脱敏（redactEmails）；
 *  - 单个探针抛错【不是 500】：FAIL / SKIP 都是合法自检结论（与 CLI 退出码语义一致），
 *    只有路由自身异常（输入装配 / 序列化挂了）才回 500。
 */
import { Router } from 'express';
import { config } from '../config';
import { receiveEnabled } from '../services/identity';
import {
  PROBE_TIMEOUT_MS,
  runProbes,
  type ProbeInput,
} from '../doctor/probes';
import { redactEmails, type CheckResult } from '../doctor/report';

/**
 * 组装探针输入 —— 与 CLI doctor.ts 的私有 collectProbeInput 保持同一口径。
 *
 * 为什么不直接 import：src/doctor.ts 是 CLI 入口，import 即执行 main()（会真跑一轮自检），
 * 且 collectProbeInput 未导出、该文件也不在本次改动白名单内。这里镜像的只是
 * 「从 config 拼 ProbeInput」这几行胶水，探针本体全部复用 runProbes；
 * 若 CLI 侧增改探针输入字段，这里必须同步。
 */
function collectProbeInput(): ProbeInput {
  const robotCodeRaw = (process.env.DINGTALK_ROBOT_CODE ?? '').trim();
  return {
    feishu: {
      appId: config.platforms.feishu.appId,
      appSecret: config.platforms.feishu.appSecret,
      baseUrl: config.platforms.feishu.baseUrl,
    },
    dingtalk: {
      appKey: config.platforms.dingtalk.appKey,
      appSecret: config.platforms.dingtalk.appSecret,
      robotCode: config.platforms.dingtalk.robotCode,
      robotCodeExplicit: robotCodeRaw.length > 0,
      aesToken: config.platforms.dingtalk.aesToken,
      aesKey: config.platforms.dingtalk.aesKey,
      stream: config.dingtalkStream,
      baseUrl: config.platforms.dingtalk.baseUrl,
    },
    mail: {
      accounts: config.mail.accounts,
      enabled: config.mail.enabled,
    },
    llm: {
      ready: config.llm.ready,
      provider: config.llm.provider,
      model: config.llm.model,
      endpoint: config.llm.endpoint,
      apiKey: config.llm.apiKey,
      minConfidence: config.llm.minConfidence,
      reason: config.llm.reason,
    },
    // config.runtime 的条目天然满足 PlatformProbeRuntime（多出的字段不会进探针结果）
    runtime: config.runtime,
    // 微信 RPA 桥：与 CLI 相同，doctor 会真的请求它的 /health（只读），确认模式与接收能力
    wechat: { bridgeUrl: config.platforms.wechat.bridgeUrl },
    // 本人身份策略：与 CLI 相同，只做只读探测（飞书 user token 读会话 / 钉钉 dws 版本与登录态）
    identity: {
      feishu: {
        policy: config.identity.feishu.policy,
        receiveEnabled: receiveEnabled(config.identity.feishu.policy, config.identity.feishu.receive),
      },
      dingtalk: {
        policy: config.identity.dingtalk.policy,
        receiveEnabled: receiveEnabled(config.identity.dingtalk.policy, config.identity.dingtalk.receive),
      },
    },
  };
}

/**
 * 与 doctor/report.ts 的 redactCheck 同一脱敏规则（该函数未导出、文件不在本次白名单内，
 * 故按同一逻辑在此复用导出的 redactEmails）：报告中绝不出现完整邮箱地址。
 */
function redactCheck(check: CheckResult): CheckResult {
  return {
    ...check,
    title: redactEmails(check.title),
    detail: redactEmails(check.detail),
    ...(check.hint !== undefined ? { hint: redactEmails(check.hint) } : {}),
  };
}

/** 探针编排意外抛错时压成的 FAIL 结论：自检失败是正常输出，绝不因此变成服务端 500 */
function internalFailCheck(e: unknown): CheckResult {
  const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    group: 'env',
    id: 'doctor:internal',
    title: '自检执行异常',
    status: 'FAIL',
    detail: `探针编排抛错：${message || '未知错误'}`,
    hint: '先重试一次；若持续出现，把这条 detail 与后端日志提给维护者（单个探针应各自兜错，这里只兜编排层的意外）。',
  };
}

/** 依赖注入点：生产默认用与 CLI 相同的 runProbes；单测传抛错桩验证「探针失败不 500」 */
export interface DoctorRouterDeps {
  runProbes?: typeof runProbes;
}

export function doctorRouter(deps: DoctorRouterDeps = {}): Router {
  const runProbesImpl = deps.runProbes ?? runProbes;
  const r = Router();

  r.get('/doctor', async (_req, res) => {
    try {
      const generatedAt = new Date().toISOString();
      let checks: CheckResult[];
      try {
        // 与 CLI main() 同参：8s 通用超时；邮箱 25s / 大模型 20s 由 runProbes 内部默认值接管
        const { checks: probeChecks } = await runProbesImpl(collectProbeInput(), {
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        checks = probeChecks.map(redactCheck);
      } catch (e) {
        // 关键语义：探针层抛错（个别探针没兜住）压成 FAIL 照常返回，绝不 500
        checks = [internalFailCheck(e)];
      }
      // 环境画像类接口按敏感口径处理：不落任何中间缓存
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, data: { generatedAt, checks } });
    } catch (e) {
      // 走到这里才是「路由自身异常」（输入装配 / 响应序列化挂了），与其它路由一致回 500 JSON
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: `自检接口异常：${message}` });
      }
    }
  });

  return r;
}
