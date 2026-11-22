import { useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Checkbox } from 'antd';
import {
  CheckCircleFilled,
  CheckSquareOutlined,
  ClockCircleOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { useAppState } from '../../hooks/useAppState';
import { store } from '../../store';
import type { UnifiedMessage } from '../../types';
import { formatRelative } from '../../utils/format';
import { formatDue, groupTodos } from '../../utils/due';
import { PlatformTag } from '../../components/PlatformTag';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState } from '../../components/EmptyState';
import { DrawerSection } from '../../components/DrawerSection';

function TodoCard({ todo, onOpen }: { todo: UnifiedMessage; onOpen: (traceId: string) => void }) {
  const due = formatDue(todo.dueAt);
  /** 手动加的待办标题优先；没有则回退消息正文 —— 正文不被覆盖，回放里仍看得到原话 */
  const title = todo.todoTitle?.trim() || todo.body;
  /** 新建发送时顺手加的待办方向是 out：不是别人发来的，显示「我发起」更准确 */
  const who = todo.direction === 'out' ? '我发起' : todo.sender.name;

  return (
    <article
      className={`surface-card surface-card--hover todo-card${todo.done ? ' is-done' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${who}：${title}`}
      onClick={() => onOpen(todo.traceId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(todo.traceId);
        }
      }}
    >
      <span className="todo-card__check" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={Boolean(todo.done)}
          onChange={() => {
            if (!todo.done) void store.markDone(todo.traceId);
          }}
        />
      </span>

      <div className="todo-card__main">
        <div className="todo-card__title">
          <span className="todo-card__sender">{who}</span>
          <PlatformTag platform={todo.platform} small />
          <span className="todo-card__time">{formatRelative(todo.createdAt)}</span>
        </div>
        <p className="todo-card__body">{title}</p>
        <div className="todo-card__foot">
          <StatusBadge status={todo.status} small />
          {todo.priority === 'urgent' && (
            <span className="chip chip--priority-flag chip--priority-flag--urgent" title="被标记为紧急，排在待办最前面">
              紧急
            </span>
          )}
          {todo.priority === 'low' && (
            <span className="chip chip--priority-flag" title="被标记为不急，排在普通待办之后">
              不急
            </span>
          )}
          {todo.direction === 'out' && <span className="chip chip--type">手动添加</span>}
          {due && !todo.done && (
            <span className={`todo-card__due todo-card__due--${due.tone}`}>
              <ClockCircleOutlined aria-hidden="true" /> {due.text}
            </span>
          )}
          <RightOutlined className="todo-card__go" aria-hidden="true" />
        </div>
      </div>
    </article>
  );
}

export function TodosPage() {
  const state = useAppState();
  const navigate = useNavigate();
  const { message: toast } = AntApp.useApp();

  /** 空态也能直接产出一条待办：Mock 走本地模拟；真实后端去收件箱注入示例 */
  const injectDemo = async (): Promise<void> => {
    try {
      await store.simulateIncoming();
      toast.success('已注入一条示例消息（模拟），稍后可在收件箱看到');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '注入失败，请到收件箱注入示例');
    }
  };

  const todos = state.messages.filter((m) => m.type === 'todo');
  const pending = todos.filter((m) => !m.done);
  const doneItems = todos.filter((m) => m.done);
  const groups = groupTodos(pending);
  const open = (traceId: string) => navigate(`/inbox/${traceId}`);

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">
            <CheckSquareOutlined /> 待办
            <span className="page__count">{pending.length}</span>
          </h1>
        </div>
      </header>

      {todos.length === 0 ? (
        <EmptyState
          title="暂无待办"
          description="当消息被识别为「待办」类型时，会出现在这里。先去看看收件箱，或连接你的账号。"
          action={
            (
              <div className="empty-state__actions">
                <Button size="small" type="primary" onClick={() => navigate('/inbox')}>
                  去收件箱
                </Button>
                {state.demoMode && (
                  <Button size="small" onClick={() => void injectDemo()}>
                    注入示例消息
                  </Button>
                )}
                <Button size="small" type="link" onClick={() => navigate('/connect')}>
                  连接账号
                </Button>
              </div>
            )
          }
        />
      ) : (
        <>
          {groups.length > 0 ? (
            groups.map((group) => (
              <section key={group.key} className={`todo-group todo-group--${group.key}`}>
                <div className="todo-group__head">
                  <span className="todo-group__label">{group.label}</span>
                  <span className="todo-group__count">{group.items.length}</span>
                </div>
                <div className="todo-grid">
                  {group.items.map((todo) => (
                    <TodoCard key={todo.traceId} todo={todo} onOpen={open} />
                  ))}
                </div>
              </section>
            ))
          ) : (
            <div className="todo-done-hint">
              <CheckCircleFilled /> 全部完成
            </div>
          )}

          {doneItems.length > 0 && (
            <DrawerSection title="已完成" summary={`${doneItems.length} 项`}>
              <div className="todo-grid todo-grid--drawer">
                {doneItems.map((todo) => (
                  <TodoCard key={todo.traceId} todo={todo} onOpen={open} />
                ))}
              </div>
            </DrawerSection>
          )}
        </>
      )}
    </div>
  );
}
