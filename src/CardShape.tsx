import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  type RecordProps,
  T,
  type TLBaseShape,
} from 'tldraw';

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
export const CARD_HEIGHT_MIN = 90;

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
    const { role, content, streaming, w, h } = shape.props;
    const isUser = role === 'user';
    return (
      <HTMLContainer
        id={shape.id}
        style={{
          width: w,
          height: h,
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff',
          border: `1px solid ${isUser ? '#d0d0d0' : '#c7dbff'}`,
          borderRadius: 8,
          color: '#111',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 13,
          lineHeight: 1.5,
          overflow: 'hidden',
          pointerEvents: 'all',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)',
        }}
      >
        <div
          style={{
            padding: '5px 10px',
            fontSize: 10,
            color: isUser ? '#8a8a8a' : '#4a90e2',
            textTransform: 'uppercase',
            letterSpacing: 1.5,
          }}
        >
          {isUser ? 'you' : '◆ assistant'}
        </div>
        <div
          style={{
            flex: 1,
            padding: '0 12px 10px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflow: 'auto',
            color: content ? '#111' : '#bbb',
            fontStyle: content ? 'normal' : 'italic',
          }}
        >
          {content || (isUser ? '(empty — type below to fill)' : 'thinking…')}
          {streaming && <span className="river-cursor">▊</span>}
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: CardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />;
  }
}
