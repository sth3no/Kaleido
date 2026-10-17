import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import App from './App';

test('renders an empty main landmark for the shell to fill', () => {
  render(<App />);
  expect(screen.getByRole('main').childElementCount).toBe(0);
});
