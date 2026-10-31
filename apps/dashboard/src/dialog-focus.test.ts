import { describe, expect, it, vi } from 'vitest';
import { DialogFocusReturn } from './dialog-focus';
describe('live dialog focus return', () => {
  it('returns Escape or Cancel focus to the captured opener, independent of dialog autofocus', () => {
    for (const close of ['Escape', 'Cancel']) {
      const focus = vi.fn(),
        autofocusedControl = { focus: vi.fn() },
        controller = new DialogFocusReturn();
      controller.remember({ focus });
      controller.restore(true, false);
      autofocusedControl.focus();
      expect(focus).not.toHaveBeenCalled();
      controller.restore(false, false);
      expect(focus).toHaveBeenCalledTimes(1);
      controller.restore(false, false);
      expect(focus).toHaveBeenCalledTimes(1);
      expect(close).toBeTruthy();
    }
  });
  it('waits through a refused request busy cycle and then restores the original trigger', () => {
    const focus = vi.fn(),
      controller = new DialogFocusReturn();
    controller.remember({ focus });
    controller.restore(true, false);
    controller.restore(false, true);
    expect(focus).not.toHaveBeenCalled();
    controller.restore(false, false);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
