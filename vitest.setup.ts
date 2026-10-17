import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only unmounts by itself when the test framework exposes globals.
afterEach(cleanup);
