export function settingsSection(container: HTMLElement, title: string, description: string): HTMLElement {
  const section = container.createDiv({ cls: 'metronome-section' });
  const header = section.createDiv({ cls: 'metronome-section-header' });
  header.createEl('h3', { text: title });
  header.createEl('p', { text: description });
  return section;
}

export function settingsMessage(container: HTMLElement, title: string, description: string, error = false): HTMLElement {
  const message = container.createDiv({ cls: `metronome-message${error ? ' metronome-message-error' : ''}` });
  message.setAttr('role', error ? 'alert' : 'status');
  message.createEl('strong', { text: title });
  message.createEl('p', { text: description });
  return message;
}
