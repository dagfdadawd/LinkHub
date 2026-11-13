import { useEffect } from 'react';
import { CheckOutlined, LeftOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { ClarityDesign } from './ClarityDesign';
import { NexusDesign } from './NexusDesign';
import { EditorialDesign } from './EditorialDesign';
import { FlowDesign } from './FlowDesign';
import { DesignToast } from './shared';
import { useDesignWorkspace } from './model';
import './design-lab.css';

const VARIANTS = [
  { id: 'clarity', number: '01', name: '秩序', en: 'CLARITY', description: '克制 · 高效 · 专业', color: '#6157e8' },
  { id: 'nexus', number: '02', name: '暗夜', en: 'NEXUS', description: '沉浸 · 精密 · 未来', color: '#b8f35a' },
  { id: 'editorial', number: '03', name: '墨韵', en: 'EDITORIAL', description: '人文 · 叙事 · 质感', color: '#d8583f' },
  { id: 'flow', number: '04', name: '浮光', en: 'FLOW', description: '黑白 · 轻盈 · 智能', color: '#17171b' },
];

export function DesignLab() {
  const workspace = useDesignWorkspace();
  const navigate = useNavigate();
  const { variant = 'clarity' } = useParams();
  const current = VARIANTS.find((item) => item.id === variant) ?? VARIANTS[0];
  useEffect(() => {
    if (!VARIANTS.some((item) => item.id === variant)) navigate('/designs/clarity', { replace: true });
  }, [variant, navigate]);
  const choose = () => {
    localStorage.setItem('linkhub-design-preference', current.id);
    workspace.notify(`已选择「${current.name} · ${current.en}」作为你的偏好方案`);
  };

  return (
    <div className="dl-lab" data-variant={current.id}>
      {current.id === 'clarity' && <ClarityDesign workspace={workspace} />}
      {current.id === 'nexus' && <NexusDesign workspace={workspace} />}
      {current.id === 'editorial' && <EditorialDesign workspace={workspace} />}
      {current.id === 'flow' && <FlowDesign workspace={workspace} />}
      <DesignToast text={workspace.toast} />
      <div className="dl-dock" aria-label="前端设计方案切换">
        <button type="button" className="dl-dock__back" onClick={() => navigate('/inbox')} title="返回当前系统"><LeftOutlined /><span>原界面</span></button>
        <span className="dl-dock__divider" />
        <div className="dl-dock__variants">{VARIANTS.map((item) => <button type="button" key={item.id} className={item.id === current.id ? 'is-active' : ''} onClick={() => navigate(`/designs/${item.id}`)} title={`${item.name} · ${item.description}`}><i style={{ background: item.color }} /><span>{item.number}</span><strong>{item.name}</strong></button>)}</div>
        <span className="dl-dock__divider" />
        <div className="dl-dock__meta"><span>{current.en}</span><small>{current.description}</small></div>
        <button type="button" className="dl-dock__choose" onClick={choose}><CheckOutlined />就选这套</button>
      </div>
    </div>
  );
}
