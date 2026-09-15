import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SUPPORTED_WALLETS, useWallet } from '@stellar-pay/wallet';
import { useAuth } from '@/lib/auth';
import { WalletButton } from './wallet-button';

jest.mock('@stellar-pay/wallet', () => ({
  SUPPORTED_WALLETS: [
    { id: 'FREIGHTER', name: 'Freighter', description: 'Browser extension' },
    { id: 'X_BULL', name: 'xBull', description: 'Extension and mobile' },
    { id: 'ALBEDO', name: 'Albedo', description: 'Web wallet, no extension' },
  ],
  useWallet: jest.fn(),
}));

jest.mock('@/lib/auth', () => ({ useAuth: jest.fn() }));

// The shared UI package is ESM-only; a plain <button> keeps this suite on the
// component's own behaviour without pulling in the Tailwind component tree.
jest.mock('@stellar-pay/ui', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    Button: ({ variant: _variant, size: _size, ...rest }: Record<string, any>) =>
      React.createElement('button', rest),
  };
});

jest.mock('lucide-react', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const Icon = () => React.createElement('svg');
  return { LogOut: Icon, Wallet: Icon, ChevronDown: Icon, Check: Icon, Loader2: Icon };
});

const KEY = `G${'B'.repeat(55)}`;
const SHORT_KEY = `${KEY.slice(0, 6)}…${KEY.slice(-4)}`;

const mockWalletContext = {
  connected: false,
  publicKey: null as string | null,
  provider: null as string | null,
  connecting: false,
  disconnect: jest.fn(),
  switchWallet: jest.fn(),
} as unknown as ReturnType<typeof useWallet>;

const mockAuthContext = {
  authenticated: false,
  loginWithWallet: jest.fn(),
  logout: jest.fn(),
} as unknown as ReturnType<typeof useAuth>;

function connectWallet(options: { authenticated?: boolean } = {}) {
  mockWalletContext.connected = true;
  mockWalletContext.publicKey = KEY;
  mockWalletContext.provider = 'FREIGHTER';
  mockAuthContext.authenticated = options.authenticated ?? false;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWalletContext.connected = false;
  mockWalletContext.publicKey = null;
  mockWalletContext.provider = null;
  mockWalletContext.connecting = false;
  mockAuthContext.authenticated = false;

  jest.mocked(useWallet).mockReturnValue(mockWalletContext);
  jest.mocked(useAuth).mockReturnValue(mockAuthContext);
});

describe('WalletButton', () => {
  it('offers the wallet picker only after the user asks for it', async () => {
    const user = userEvent.setup();
    render(<WalletButton />);

    expect(screen.queryByText('Freighter')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /connect wallet/i }));

    for (const wallet of SUPPORTED_WALLETS) {
      expect(screen.getByText(wallet.name)).toBeInTheDocument();
      expect(screen.getByText(wallet.description)).toBeInTheDocument();
    }
  });

  it('signs in with the wallet the user picks', async () => {
    const user = userEvent.setup();
    render(<WalletButton />);

    await user.click(screen.getByRole('button', { name: /connect wallet/i }));
    await user.click(screen.getByText('xBull'));

    expect(mockAuthContext.loginWithWallet).toHaveBeenCalledWith('X_BULL');
  });

  it('shows the abbreviated key and the active provider once connected', () => {
    connectWallet();
    render(<WalletButton />);

    expect(screen.getByRole('button', { name: new RegExp(SHORT_KEY) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /freighter/i })).toBeInTheDocument();
  });

  it('reports whether the wallet is merely connected or also signed in', async () => {
    const user = userEvent.setup();
    connectWallet({ authenticated: true });
    render(<WalletButton />);

    await user.click(screen.getByRole('button', { name: new RegExp(SHORT_KEY) }));

    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText(KEY)).toBeInTheDocument();
  });

  it('switches provider without a full reconnect', async () => {
    const user = userEvent.setup();
    connectWallet();
    render(<WalletButton />);

    await user.click(screen.getByRole('button', { name: new RegExp(SHORT_KEY) }));
    await user.click(screen.getByRole('button', { name: /^xBull$/ }));

    expect(mockWalletContext.switchWallet).toHaveBeenCalledWith('X_BULL');
  });

  it('signs out and disconnects the wallet', async () => {
    const user = userEvent.setup();
    connectWallet({ authenticated: true });
    render(<WalletButton />);

    await user.click(screen.getByRole('button', { name: new RegExp(SHORT_KEY) }));
    await user.click(screen.getByRole('button', { name: /disconnect/i }));

    expect(mockAuthContext.logout).toHaveBeenCalled();
    expect(mockWalletContext.disconnect).toHaveBeenCalled();
  });

  it('closes the picker when the user clicks elsewhere', async () => {
    const user = userEvent.setup();
    render(<WalletButton />);

    await user.click(screen.getByRole('button', { name: /connect wallet/i }));
    expect(screen.getByText('Freighter')).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByText('Freighter')).not.toBeInTheDocument();
  });

  it('disables the trigger while a connection is in flight', () => {
    mockWalletContext.connecting = true;
    render(<WalletButton />);

    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeDisabled();
  });
});
