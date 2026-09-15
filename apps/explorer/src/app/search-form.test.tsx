import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { SearchForm } from './search-form';

jest.mock('next/navigation', () => ({ useRouter: jest.fn() }));

// The shared UI package is ESM-only; a plain <input> keeps this suite on the
// form's routing behaviour instead of the Tailwind component tree.
jest.mock('@stellar-pay/ui', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    Input: ({ className: _className, ...rest }: Record<string, any>) =>
      React.createElement('input', rest),
  };
});

jest.mock('lucide-react', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return { Search: () => React.createElement('svg') };
});

const mockPush = jest.fn();
const ACCOUNT_KEY = `G${'A'.repeat(55)}`;
const TX_HASH = 'b'.repeat(64);

/**
 * jsdom does not implement implicit form submission (Enter in a text input), so
 * the value is typed with user-event and the submit is dispatched explicitly —
 * the component's onSubmit handler is still what is under test.
 */
async function searchFor(value: string) {
  const user = userEvent.setup();
  render(<SearchForm />);

  const input = screen.getByPlaceholderText(/search tx hash or account/i);
  if (value) {
    await user.type(input, value);
  }
  fireEvent.submit(input.closest('form') as HTMLFormElement);
}

describe('SearchForm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(useRouter)
      .mockReturnValue({ push: mockPush } as unknown as ReturnType<typeof useRouter>);
  });

  it('routes a 56-character account key to the account page', async () => {
    await searchFor(ACCOUNT_KEY);
    expect(mockPush).toHaveBeenCalledWith(`/account/${ACCOUNT_KEY}`);
  });

  it('routes anything that is not an account key to the transaction page', async () => {
    await searchFor(TX_HASH);
    expect(mockPush).toHaveBeenCalledWith(`/tx/${TX_HASH}`);
  });

  it('trims surrounding whitespace before routing', async () => {
    await searchFor(`  ${ACCOUNT_KEY}  `);
    expect(mockPush).toHaveBeenCalledWith(`/account/${ACCOUNT_KEY}`);
  });

  it('does not navigate on an empty or whitespace-only query', async () => {
    await searchFor('   ');
    expect(mockPush).not.toHaveBeenCalled();
  });
});
