/**
 * WS 心跳单测：只测「单轮心跳」的纯逻辑，不起真实服务端。
 *
 * 关键契约（与前端 WsRealtime 的看门狗配合）：
 *  - 活连接每轮收到 协议层 ping + 应用层 {type:'heartbeat'} 帧；
 *  - 上一轮没回 pong 的连接被 terminate 回收（半开连接不会永远占着）；
 *  - 前端阈值 = 3 个心跳周期，所以 WS_HEARTBEAT_MS 必须明显小于 75s。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { heartbeatRound, markWsAlive, WS_HEARTBEAT_MS } from './ws';

interface FakeClient {
  readyState: number;
  pings: number;
  sent: string[];
  terminated: number;
}

/** 伪造 ws 连接：只实现心跳用到的四个成员，再断言调用次数 */
function fakeClient(readyState: number = WebSocket.OPEN): FakeClient & WebSocket {
  const client = {
    readyState,
    pings: 0,
    sent: [] as string[],
    terminated: 0,
    ping() {
      this.pings += 1;
    },
    send(data: string) {
      this.sent.push(data);
    },
    terminate() {
      this.terminated += 1;
    },
  };
  return client as unknown as FakeClient & WebSocket;
}

test('心跳周期足够短，保证前端 75s 阈值内能发现静默断链', () => {
  assert.ok(WS_HEARTBEAT_MS < 75_000);
});

test('首轮：活连接收到 ping + 应用层 heartbeat 帧，不被回收', () => {
  const client = fakeClient();

  assert.equal(heartbeatRound([client]), 0);

  assert.equal(client.pings, 1);
  assert.equal(client.terminated, 0);
  const frame = JSON.parse(client.sent[0]) as { type: string };
  assert.equal(frame.type, 'heartbeat');
});

test('次轮：没回 pong 的连接被 terminate；回过 pong 的保留', () => {
  const dead = fakeClient();
  const alive = fakeClient();

  heartbeatRound([dead, alive]);
  markWsAlive(alive); // 模拟浏览器自动回 pong

  assert.equal(heartbeatRound([dead, alive]), 1);
  assert.equal(dead.terminated, 1);
  assert.equal(alive.terminated, 0);
});

test('已关闭的连接既不发送也不计入回收', () => {
  const closed = fakeClient(WebSocket.CLOSED);

  assert.equal(heartbeatRound([closed]), 0);
  assert.equal(closed.pings, 0);
  assert.equal(closed.terminated, 0);
});
