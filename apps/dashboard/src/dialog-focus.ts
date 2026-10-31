interface FocusTarget {
  focus(): void;
}
/** Remember the activation target before the dialog mounts; defer return while its trigger is disabled. */
export class DialogFocusReturn {
  private opener: FocusTarget | null = null;
  remember(target: FocusTarget): void {
    this.opener = target;
  }
  restore(dialogOpen: boolean, busy: boolean): void {
    if (dialogOpen || busy || !this.opener) return;
    const target = this.opener;
    this.opener = null;
    target.focus();
  }
}
