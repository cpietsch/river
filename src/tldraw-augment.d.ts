import type { CardShape } from './CardShape';

declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    card: CardShape['props'];
  }
}
