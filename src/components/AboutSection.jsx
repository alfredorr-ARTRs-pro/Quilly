import { useEffect, useState } from 'react';
import './AboutSection.css';

const REPO = 'https://github.com/alfredorr-ARTRs-pro/Quilly';
// Store ID 9PFHD727T69M ("Quilly Voice to Text"); the protocol link opens the Store app.
const STORE_LINK = 'ms-windows-store://pdp/?productid=9PFHD727T69M';

const LINKS = [
    { label: 'Source code on GitHub', href: REPO },
    { label: 'Report a problem', href: `${REPO}/issues` },
    { label: 'Release notes', href: `${REPO}/releases` },
    { label: 'Privacy policy', href: `${REPO}/blob/main/PRIVACY_POLICY.md` },
    { label: 'License (MIT)', href: `${REPO}/blob/main/LICENSE` },
    { label: 'Third-party licenses', href: `${REPO}/blob/main/THIRD_PARTY_LICENSES.md` },
];

const COMPANIES = [
    { label: 'A.I.P.S. — AI studio', href: 'https://aips.studio' },
    { label: 'ARTRs Pro — AI agents & engineering', href: 'https://artrspro.com' },
    { label: 'MyPCFriends — IT & cybersecurity', href: 'https://mypcfriends.com' },
];

const DONATE = [
    { label: '❤️ Sponsor on GitHub', href: 'https://github.com/sponsors/alfredorr-ARTRs-pro', className: 'about-donate--github' },
    { label: 'Donate via PayPal', href: 'https://www.paypal.com/donate/?hosted_button_id=EY723ETLSVH9G', className: 'about-donate--paypal' },
];

function updateMessage(result) {
    if (!result) return null;
    switch (result.status) {
        case 'available': return `Quilly ${result.latestVersion} is available.`;
        case 'up-to-date': return 'You have the latest version.';
        case 'error': return 'Couldn\'t check for updates. Check your internet connection and try again.';
        default: return null;
    }
}

// Version, updates, links, donations and legal info. Shown at the bottom of
// Settings and on the About page.
function AboutSection() {
    const [info, setInfo] = useState(null);
    const [autoCheck, setAutoCheck] = useState(true);
    const [checking, setChecking] = useState(false);
    const [result, setResult] = useState(null);

    useEffect(() => {
        window.electronAPI?.getAppInfo?.().then(setInfo).catch(() => {});
        window.electronAPI?.getSettings?.()
            .then(s => setAutoCheck(s?.autoUpdateCheck !== false))
            .catch(() => {});
    }, []);

    const handleCheck = async () => {
        setChecking(true);
        try {
            setResult(await window.electronAPI.checkForUpdates());
        } catch {
            setResult({ status: 'error' });
        } finally {
            setChecking(false);
        }
    };

    const handleToggleAutoCheck = async () => {
        const next = !autoCheck;
        setAutoCheck(next);
        const res = await window.electronAPI?.setSetting?.('autoUpdateCheck', next).catch(() => null);
        if (res && res.success === false) setAutoCheck(!next);
    };

    const isStore = info?.isWindowsStore === true;

    return (
        <section className="settings-section about-section">
            <h3>About &amp; Updates</h3>

            <div className="about-version-row">
                <div>
                    <div className="about-product">Quilly {info ? `v${info.version}` : ''}</div>
                    <div className="section-description about-edition">
                        {isStore ? 'Microsoft Store edition' : 'Free and open source'} · Talk more, type less
                    </div>
                </div>
                {!isStore && (
                    <button className="btn-secondary" onClick={handleCheck} disabled={checking || !info} type="button">
                        {checking ? 'Checking…' : 'Check for updates'}
                    </button>
                )}
            </div>

            {isStore ? (
                <p className="section-description">
                    Updates are installed automatically by the Microsoft Store.{' '}
                    <a className="about-inline-link" href={STORE_LINK} target="_blank" rel="noreferrer">
                        Open in Microsoft Store
                    </a>
                </p>
            ) : (
                <>
                    {result && (
                        <p className={`about-update-status about-update-status--${result.status}`}>
                            {updateMessage(result)}{' '}
                            {result.status === 'available' && (
                                <a href={result.url} target="_blank" rel="noreferrer">Download</a>
                            )}
                        </p>
                    )}
                    <div className="review-first-row">
                        <div className="review-first-label-group">
                            <span className="review-first-label">Check for updates automatically</span>
                            <span className="review-first-description">
                                Once a day, Quilly asks GitHub whether a newer version exists. Nothing else is sent.
                            </span>
                        </div>
                        <button
                            className={`llm-switch ${autoCheck ? 'llm-switch--on' : ''}`}
                            role="switch"
                            aria-checked={autoCheck}
                            onClick={handleToggleAutoCheck}
                            type="button"
                        >
                            <span className="llm-switch-thumb" />
                        </button>
                    </div>
                </>
            )}

            <ul className="about-links">
                {LINKS.map(link => (
                    <li key={link.href}>
                        <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
                    </li>
                ))}
            </ul>

            <div className="about-companies">
                <span className="about-companies-title">Companies behind Quilly</span>
                <ul className="about-links">
                    {COMPANIES.map(link => (
                        <li key={link.href}>
                            <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
                        </li>
                    ))}
                </ul>
            </div>

            <div className="about-support">
                <p className="section-description">
                    Quilly is free. If it saves you time, you can support its development.
                    Donations are voluntary and unlock nothing.
                </p>
                <div className="about-donate">
                    {DONATE.map(d => (
                        <a key={d.href} className={`about-donate-btn ${d.className}`} href={d.href} target="_blank" rel="noreferrer">
                            {d.label}
                        </a>
                    ))}
                </div>
            </div>

            <p className="about-legal">
                Created by Alfredo Rapetta at A.I.P.S. · © 2026 ARTRs pro AB · MIT License
            </p>
        </section>
    );
}

export default AboutSection;
