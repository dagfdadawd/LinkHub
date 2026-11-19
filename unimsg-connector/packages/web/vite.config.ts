import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const sharedEntry = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));

// LinkHub Web · Vite + Vitest 一体化配置
export default defineConfig({
  plugins: [react()],
  // 构建/启动时间戳：一眼判断浏览器跑的是不是最新代码（旧产物排查过很久）
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      // 直接复用 monorepo 的统一消息契约
      '@unimsg/shared': sharedEntry,
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  // 本机验证时把构建产物与缓存写到可写目录；正常开发保持默认
  cacheDir: process.env.WEB_CACHE_DIR || 'node_modules/.vite',
  build: {
    outDir: process.env.WEB_OUT_DIR || 'dist',
    // antd 全量组件库体积固有偏大（gzip 后约 160KB），已通过 tree-shaking 最小化；
    // 阈值按实际产物设定，避免把已知权衡误报为构建告警。
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 三层单向拆分：业务 → antd（含 rc-* 底层组件）→ vendor → react-vendor。
        // 之前 antd 与杂项全挤在 vendor 里，单文件 938 kB（gzip 297 kB），
        // 首屏要等一整块解析完；拆出来后 vendor 只剩真正零散的依赖。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('/scheduler/') ||
            id.includes('/react-is/') ||
            id.includes('react-router') ||
            id.includes('@remix-run')
          ) {
            return 'react-vendor';
          }
          if (
            id.includes('/antd/') ||
            id.includes('@ant-design/') ||
            id.includes('/rc-') ||
            id.includes('@rc-component/')
          ) {
            return 'antd';
          }
          return 'vendor';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    // 授权中心（ConnectPage）等重型 antd 交互用例在单核/慢速 CI runner 上单测 5–6s 很常见，
    // 默认 5s 会随机超时（本地快、CI 挂）。放宽到 15s，避免把「机器慢」误报成用例失败。
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});