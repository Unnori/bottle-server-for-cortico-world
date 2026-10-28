import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试量很小，串行更稳；页面与本地端口都用假件，不开真 socket。
    fileParallelism: false,
  },
});
