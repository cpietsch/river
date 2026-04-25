import { useEffect, type MutableRefObject } from 'react';
import type { Editor } from 'tldraw';
import { useConversation } from './store';
import { syncStoreToTldraw } from './sync';
import type { Turn, TurnId } from './types';

/**
 * Subscribe to the conversation store and reflect every change into tldraw.
 * Called once from App with the editor ref. The `onStructuralChange` callback
 * fires after `syncStoreToTldraw` whenever a turn is created or removed —
 * App uses it to trigger `relayoutAll`, which is a positioning concern that
 * lives outside this layer.
 */
export function useTldrawSync(
  editorRef: MutableRefObject<Editor | null>,
  onStructuralChange?: () => void,
): void {
  useEffect(() => {
    let prev = useConversation.getState().turns;
    // Initial flush — apply current store state to tldraw on mount.
    if (editorRef.current) {
      syncStoreToTldraw(editorRef.current);
      onStructuralChange?.();
    }
    const unsubscribe = useConversation.subscribe((state) => {
      const editor = editorRef.current;
      if (!editor) return;
      const next = state.turns;
      const structural = isStructuralChange(prev, next);
      syncStoreToTldraw(editor);
      prev = next;
      if (structural) onStructuralChange?.();
    });
    return unsubscribe;
  }, [editorRef, onStructuralChange]);
}

function isStructuralChange(
  prev: Record<TurnId, Turn>,
  next: Record<TurnId, Turn>,
): boolean {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return true;
  for (const k of nextKeys) {
    if (!(k in prev)) return true;
    if (prev[k as TurnId].parentId !== next[k as TurnId].parentId) return true;
  }
  return false;
}
