import {ApplicationState} from '../state/state.js';

export interface ApplicationUI {
  render(): void;
  update(state: ApplicationState): void;
}
