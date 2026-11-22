import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';

const hoisted = vi.hoisted(() => ({
  store: {
    mailAccountTest: vi.fn(),
    mailAccountCreate: vi.fn(async () => {}),
  },
}));

vi.mock('../../store', () => ({ store: hoisted.store }));

import { MailAccountForm, buildMailAccountInput } from './MailAccountForm';

function renderForm(props: Parameters<typeof MailAccountForm>[0] = {}) {
  render(
    <AntApp>
      <MailAccountForm {...props} />
    </AntApp>,
  );
}

function fillBasic(address = 'me@qq.com', authCode = 'abcdefghij') {
  fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: address } });
  fireEvent.change(screen.getByLabelText('授权码'), { target: { value: authCode } });
}

beforeEach(() => {
  hoisted.store.mailAccountTest.mockResolvedValue({
    ok: true,
    message: 'IMAP / SMTP 登录成功',
    details: ['IMAP：连接正常', 'SMTP：连接正常'],
  });
  hoisted.store.mailAccountCreate.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('邮箱添加表单（个人版核心）', () => {
  it('默认 QQ 预设 + 授权码是 password 输入 + 显示服务商设置页说明', () => {
    renderForm();
    expect(screen.getByLabelText('服务商')).toBeInTheDocument();
    expect(screen.getByLabelText('邮箱地址')).toBeInTheDocument();
    expect(screen.getByLabelText('授权码')).toHaveAttribute('type', 'password');
    expect(screen.getByText(/QQ 邮箱网页版 → 设置/)).toBeInTheDocument();
    // 高级设置默认收起，但表单值已按 QQ 预设填好（展开后可见）
    fireEvent.click(screen.getByText('高级设置（收信 / 发信服务器，一般不用改）'));
    expect(screen.getByLabelText('收信服务器地址')).toHaveValue('imap.qq.com');
    expect(screen.getByLabelText('发信服务器地址')).toHaveValue('smtp.qq.com');
  });

  it('切换服务商自动带出对应服务器；Gmail 提示应用专用密码', async () => {
    renderForm();
    fireEvent.mouseDown(screen.getByLabelText('服务商'));
    fireEvent.click(await screen.findByTitle('Gmail'));
    await waitFor(() => {
      expect(screen.getByText(/应用专用密码/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('高级设置（收信 / 发信服务器，一般不用改）'));
    expect(screen.getByLabelText('收信服务器地址')).toHaveValue('imap.gmail.com');
    expect(screen.getByLabelText('发信服务器地址')).toHaveValue('smtp.gmail.com');
  });

  it('测试连接：提交完整 payload（含服务器/端口），展示成功明细', async () => {
    renderForm();
    fillBasic();
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }));

    await waitFor(() => expect(hoisted.store.mailAccountTest).toHaveBeenCalledTimes(1));
    expect(hoisted.store.mailAccountTest).toHaveBeenCalledWith({
      provider: 'qq',
      address: 'me@qq.com',
      authCode: 'abcdefghij',
      label: 'QQ 邮箱',
      imapHost: 'imap.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
    });
    expect(await screen.findByTestId('mail-test-result')).toBeInTheDocument();
    expect(screen.getByText('连接测试通过')).toBeInTheDocument();
    expect(screen.getByText(/IMAP：连接正常/)).toBeInTheDocument();
  });

  it('测试连接失败：展示中文原因，不显示假的成功', async () => {
    hoisted.store.mailAccountTest.mockResolvedValue({
      ok: false,
      message: '授权码无效或已过期：请重新生成后再试',
    });
    renderForm();
    fillBasic();
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }));

    expect(await screen.findByText('连接测试失败')).toBeInTheDocument();
    expect(screen.getAllByText(/授权码无效或已过期/).length).toBeGreaterThan(0);
  });

  it('保存：未测试时需二次确认；调用创建接口并回调 onSaved（授权码只在请求体里）', async () => {
    const onSaved = vi.fn();
    renderForm({ onSaved });
    fillBasic('me@163.com', 'auth-code-123');
    fireEvent.click(screen.getByRole('button', { name: /保存账号/ }));

    // P2-3：未测试/测试失败的账号保存前必须二次确认（会标记「未验证」）
    expect(await screen.findAllByDisplayValue('me@163.com')).toBeTruthy();
    expect((await screen.findAllByText('还没有通过连接测试')).length).toBeGreaterThan(0);
    expect(hoisted.store.mailAccountCreate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /仍然保存/ }));

    await waitFor(() => expect(hoisted.store.mailAccountCreate).toHaveBeenCalledTimes(1));
    expect(hoisted.store.mailAccountCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'qq',
        address: 'me@163.com',
        authCode: 'auth-code-123',
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // 提交后表单重置，不在界面上回显授权码
    await waitFor(() => expect(screen.getByLabelText('邮箱地址')).toHaveValue(''));
  });

  it('测试通过后保存不再二次确认，并提示已保存生效', async () => {
    renderForm();
    fillBasic('me@qq.com', 'auth-code-123');
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }));
    await waitFor(() => expect(hoisted.store.mailAccountTest).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /保存账号/ }));

    await waitFor(() => expect(hoisted.store.mailAccountCreate).toHaveBeenCalledTimes(1));
    expect(hoisted.store.mailAccountCreate).toHaveBeenCalledWith(
      expect.objectContaining({ verify: true }),
    );
    expect(screen.queryByText('还没有通过连接测试')).not.toBeInTheDocument();
    expect(await screen.findByText(/已通过测试验证，可直接真实收信/)).toBeInTheDocument();
  });

  it('必填校验：地址 / 授权码为空时不调用后端', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /保存账号/ }));

    expect(await screen.findByText('请填写邮箱地址')).toBeInTheDocument();
    expect(screen.getByText('请填写邮箱授权码（不是登录密码）')).toBeInTheDocument();
    expect(hoisted.store.mailAccountCreate).not.toHaveBeenCalled();
  });

  it('自定义服务商要求填 IMAP / SMTP 服务器', async () => {
    renderForm();
    fireEvent.mouseDown(screen.getByLabelText('服务商'));
    fireEvent.click(await screen.findByTitle('自定义 / 企业邮箱'));
    fireEvent.click(screen.getByText('高级设置（收信 / 发信服务器，一般不用改）'));
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'me@company.com' } });
    fireEvent.change(screen.getByLabelText('授权码'), { target: { value: 'secret-code' } });
    fireEvent.click(screen.getByRole('button', { name: /保存账号/ }));

    expect(await screen.findByText('请填写收信服务器地址')).toBeInTheDocument();
    expect(screen.getByText('请填写发信服务器地址')).toBeInTheDocument();
    expect(hoisted.store.mailAccountCreate).not.toHaveBeenCalled();
  });
});

describe('buildMailAccountInput', () => {
  it('去空格、补服务商 label、只带非空服务器字段', () => {
    expect(
      buildMailAccountInput({
        provider: 'qq',
        address: '  me@qq.com ',
        authCode: ' code ',
        imapHost: '',
        smtpHost: '  smtp.qq.com ',
      }),
    ).toEqual({
      provider: 'qq',
      address: 'me@qq.com',
      authCode: 'code',
      label: 'QQ 邮箱',
      smtpHost: 'smtp.qq.com',
    });
  });

  it('保留自定义 label 与端口', () => {
    expect(
      buildMailAccountInput({
        provider: 'custom',
        address: 'me@company.com',
        authCode: 'x',
        label: '公司邮箱',
        imapHost: 'imap.company.com',
        imapPort: 993,
        smtpHost: 'smtp.company.com',
        smtpPort: 587,
      }),
    ).toMatchObject({
      label: '公司邮箱',
      imapHost: 'imap.company.com',
      imapPort: 993,
      smtpHost: 'smtp.company.com',
      smtpPort: 587,
    });
  });
});

