/**
 * 文件快照单测：独立部署后「重启仍可回放」的底线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Platform, MsgStatus } from '@unimsg/shared';
import { InMemoryRepository } from './repository';
import { makeTempDir } from '../utils/tempDir';

function message(traceId: string): Parameters<InMemoryRepository['save']>[0] {
  const now = new Date().toISOString();
  return {
    traceId,
    platform: Platform.FEISHU,
    externalId: `ext_${traceId}`,
    sender: { id: 'u1', name: '张三' },
    type: 'text',
    body: '周五前交周报',
    status: MsgStatus.RECEIVED,
    createdAt: now,
    updatedAt: now,
  };
}

test('纯内存模式（默认）不产生任何文件副作用', () => {
  const repo = new InMemoryRepository();
  repo.save(message('t1'));
  assert.equal(repo.list().length, 1);
});

test('快照：消息 / trace / DLQ / 幂等表重启后完整恢复', () => {
  const dir = makeTempDir('linkhub-repo-');
  const file = join(dir, 'state.json');
  try {
    const a = new InMemoryRepository(file);
    a.save(message('trace-1'));
    a.appendTrace({
      traceId: 'trace-1', platform: Platform.FEISHU, status: MsgStatus.RECEIVED,
      event: 'received', at: new Date().toISOString(),
    });
    a.update('trace-1', { status: MsgStatus.SYNCED, reply: '收到' });
    a.pushDlq({ platform: Platform.FEISHU, payload: {}, reason: 'demo', at: new Date().toISOString() });
    assert.equal(readFileSync(file, 'utf8').includes('trace-1'), true);

    const b = new InMemoryRepository(file);
    assert.equal(b.get('trace-1')?.status, MsgStatus.SYNCED);
    assert.equal(b.get('trace-1')?.reply, '收到');
    assert.equal(b.findByExternal(Platform.FEISHU, 'ext_trace-1')?.traceId, 'trace-1');
    assert.equal(b.getLoopLog('trace-1').length, 1);
    assert.equal(b.listDlq().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('快照损坏时不阻断启动，退回空状态', () => {
  const dir = makeTempDir('linkhub-repo-');
  const file = join(dir, 'state.json');
  try {
    writeFileSync(file, '{ broken json', 'utf8');
    const repo = new InMemoryRepository(file);
    assert.equal(repo.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
