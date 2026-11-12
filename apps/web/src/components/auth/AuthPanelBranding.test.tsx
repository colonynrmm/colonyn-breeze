import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLoginContext } from '../../lib/loginContext';
import type { LoginContext } from '../../lib/loginContext';

vi.mock('../../lib/loginContext', () => ({
  getLoginContext: vi.fn(),
}));

import AuthPanelBranding from './AuthPanelBranding';

const mockedGetLoginContext = vi.mocked(getLoginContext);

function resolveWith(ctx: LoginContext) {
  mockedGetLoginContext.mockResolvedValue(ctx);
}

describe('AuthPanelBranding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders stock Colonyn content when branding is null', async () => {
    resolveWith({ branding: null, partnerSso: null });

    render(<AuthPanelBranding tagline="The modern RMM platform." />);

    // Stock wordmark (colony + n, two-tone) + marketing copy present.
    const wordmark = screen.getByLabelText('Colonyn', { selector: 'span' });
    expect(wordmark.textContent).toBe('colonyn');
    expect(wordmark.querySelector('span')?.textContent).toBe('n');
    expect(screen.getByText(/Effortless endpoint/i)).toBeInTheDocument();
    expect(screen.getByText('10,000+ endpoints')).toBeInTheDocument();

    // Give the (null) effect a chance to run; content must stay stock.
    await Promise.resolve();
    expect(screen.getByText('10,000+ endpoints')).toBeInTheDocument();
    expect(screen.queryByTestId('partner-logo')).not.toBeInTheDocument();

    // The stock Colonyn mark keeps its original size (only partner logos grew).
    const stockMark = wordmark.previousElementSibling as HTMLImageElement;
    expect(stockMark.tagName.toLowerCase()).toBe('img');
    expect(stockMark.getAttribute('src')).toBe('/brand-logo-on-brand.svg');
    expect(stockMark.getAttribute('class')).toBe('h-8 w-8 object-contain');
  });

  it('renders partner branding and drops marketing copy when branding is present', async () => {
    resolveWith({
      branding: { logoUrl: 'https://x/logo.png', accentColor: '#112233', headline: 'Acme IT' },
      partnerSso: null,
    });

    const { container } = render(<AuthPanelBranding tagline="The modern RMM platform." />);

    await screen.findByText('Acme IT');

    // Marketing copy is gone.
    expect(screen.queryByText('10,000+ endpoints')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Colonyn', { selector: 'span' })).not.toBeInTheDocument();

    // Partner logo present.
    const logo = screen.getByTestId('partner-logo') as HTMLImageElement;
    expect(logo).toBeInTheDocument();
    expect(logo.getAttribute('src')).toBe('https://x/logo.png');

    // #7899: the logo was a fixed 32px tall (h-8), capped at 180px wide, so a
    // round badge logo rendered unreadably small. It must render larger, scale
    // to fit (object-contain), and cap its width at min(panel width, 280px) so a
    // wide wordmark cannot overflow the ~242px-wide panel at the md breakpoint.
    const logoClasses = logo.className.split(/\s+/);
    expect(logoClasses).not.toContain('h-8');
    expect(logoClasses).toContain('h-16');
    expect(logoClasses).toContain('lg:h-20');
    expect(logoClasses).toContain('object-contain');
    expect(logoClasses).toContain('max-w-[min(100%,280px)]');
    expect(logoClasses).not.toContain('max-w-[180px]');

    // Accent color applied to the panel background.
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.style.backgroundColor).toBe('rgb(17, 34, 51)');
  });

  it('asks for the slug-scoped context when rendered for a partner slug (#4017)', async () => {
    resolveWith({ branding: null, partnerSso: null });

    render(<AuthPanelBranding tagline="t" partnerSlug="acme-msp" />);

    await waitFor(() => expect(mockedGetLoginContext).toHaveBeenCalledWith('acme-msp'));
  });
});
