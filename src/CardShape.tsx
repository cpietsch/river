import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  type RecordProps,
  T,
  type TLBaseShape,
} from 'tldraw';
import { useCardActions } from './CardActions';

export type CardShape = TLBaseShape<
  'card',
  {
    w: number;
    h: number;
    role: 'user' | 'assistant';
    content: string;
    streaming: boolean;
  }
>;

const cardShapeProps: RecordProps<CardShape> = {
  w: T.number,
  h: T.number,
  role: T.literalEnum('user', 'assistant'),
  content: T.string,
  streaming: T.boolean,
};

export const CARD_WIDTH = 320;
export const CARD_HEIGHT_MIN = 120;

export class CardShapeUtil extends ShapeUtil<CardShape> {
  static override type = 'card' as const;
  static override props = cardShapeProps;

  override canEdit = () => false;
  override canResize = () => true;
  override isAspectRatioLocked = () => false;

  getDefaultProps(): CardShape['props'] {
    return {
      w: CARD_WIDTH,
      h: CARD_HEIGHT_MIN,
      role: 'user',
      content: '',
      streaming: false,
    };
  }

  getGeometry(shape: CardShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  component(shape: CardShape) {
    return <CardBody shape={shape} />;
  }

  indicator(shape: CardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />;
  }
}

function CardBody({ shape }: { shape: CardShape }) {
  const { role, content, streaming, w, h } = shape.props;
  const isUser = role === 'user';
  const actions = useCardActions();
  const isActive = actions?.activeId === shape.id;

  const borderColor = isActive
    ? '#111'
    : isUser
      ? '#cfcdc6'
      : '#c7dbff';

  return (
    <HTMLContainer
      id={shape.id}
      style={{
        width: w,
        height: h,
        display: 'flex',
        flexDirection: 'column',
        background: '#ffffff',
        border: `${isActive ? 2 : 1}px solid ${borderColor}`,
        borderRadius: 10,
        color: '#111',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 14,
        lineHeight: 1.5,
        overflow: 'hidden',
        pointerEvents: 'all',
        boxShadow: isActive
          ? '0 3px 10px rgba(0,0,0,0.14), 0 6px 22px rgba(0,0,0,0.08)'
          : '0 1px 3px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '5px 10px 3px',
          fontSize: 10,
          color: isUser ? '#8a8a8a' : '#4a90e2',
          textTransform: 'uppercase',
          letterSpacing: 1.5,
        }}
      >
        <span>{isUser ? 'you' : '◆ assistant'}</span>
        {isActive && !isUser && <span style={{ color: '#bbb' }}>active</span>}
      </div>
      <div
        style={{
          flex: 1,
          padding: '0 12px 8px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflow: 'auto',
          color: content ? '#111' : '#bbb',
          fontStyle: content ? 'normal' : 'italic',
        }}
      >
        {content || (isUser ? '(empty — type below)' : 'thinking…')}
        {streaming && <span className="river-cursor">▊</span>}
      </div>
      {/* Per-card action row */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 6,
          padding: '4px 8px 8px',
          borderTop: '1px solid #f0efea',
        }}
      >
        {!isActive && (
          <button
            type="button"
            onPointerDown={(e) => {
              // Stop tldraw from treating this as a shape drag/select
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              actions?.branchFrom(shape.id);
            }}
            aria-label="Branch from here"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '6px 10px',
              background: '#f7f6f2',
              border: '1px solid #cfcdc6',
              borderRadius: 999,
              color: '#111',
              font: 'inherit',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              minHeight: 32,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M7 5v9a4 4 0 0 0 4 4h7M15 14l3 3-3 3"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            branch
          </button>
        )}
      </div>
    </HTMLContainer>
  );
}
