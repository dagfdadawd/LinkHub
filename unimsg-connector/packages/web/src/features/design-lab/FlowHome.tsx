import { RetweetOutlined } from '@ant-design/icons';
import { FlowDesign } from './FlowDesign';
import { DesignToast } from './shared';
import { useLiveDesignWorkspace } from './liveWorkspace';
import { useAppState } from '../../hooks/useAppState';
import { store } from '../../store';
import './design-lab.css';

/** 浮光正式主界面：接入真实消息与操作，不再是独立演示数据。 */
export function FlowHome() {
  const workspace = useLiveDesignWorkspace();
  const state = useAppState();
  return (
    <>
      <FlowDesign workspace={workspace} />
      {state.error && (
        <div className="fl-connection-alert" role="alert">
          <span><i />数据连接异常：{state.error}</span>
          <button type="button" onClick={() => void store.refresh()}><RetweetOutlined />重试</button>
          <button type="button" onClick={() => { window.location.href = '/inbox'; }}>打开旧版排查</button>
        </div>
      )}
      <DesignToast text={workspace.toast} />
    </>
  );
}
