import { describe, it, expect } from 'vitest';
import { shouldFilterEvent } from '../../src/parser/eventFilter';
import type { JsonlEntry } from '../../src/types';

describe('shouldFilterEvent', () => {
    it('filters kind=1 inputState when enabled', () => {
        const entry: JsonlEntry = { kind: 1, k: ['inputState', 'value'], v: 'typing...' };
        expect(shouldFilterEvent(entry, true)).toBe(true);
    });

    it('filters kind=2 inputState when enabled', () => {
        const entry: JsonlEntry = { kind: 2, k: ['inputState', 'history'], v: ['item'] };
        expect(shouldFilterEvent(entry, true)).toBe(true);
    });

    it('does NOT filter inputState when disabled', () => {
        const entry: JsonlEntry = { kind: 1, k: ['inputState', 'value'], v: 'typing...' };
        expect(shouldFilterEvent(entry, false)).toBe(false);
    });

    it('does NOT filter normal kind=1 events', () => {
        const entry: JsonlEntry = { kind: 1, k: ['title'], v: 'My Chat' };
        expect(shouldFilterEvent(entry, true)).toBe(false);
    });

    it('does NOT filter kind=2 on requests', () => {
        const entry: JsonlEntry = { kind: 2, k: ['requests'], v: [{ text: 'hello' }] };
        expect(shouldFilterEvent(entry, true)).toBe(false);
    });

    it('does NOT filter kind=0', () => {
        const entry: JsonlEntry = { kind: 0, v: { inputState: 'whatever' } };
        expect(shouldFilterEvent(entry, true)).toBe(false);
    });

    it('does NOT filter kind=3 (even on inputState)', () => {
        const entry: JsonlEntry = { kind: 3, k: ['inputState'] };
        // kind=3 is rare delete — don't filter it, let it through
        expect(shouldFilterEvent(entry, true)).toBe(false);
    });
});
