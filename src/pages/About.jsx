import React from 'react';
import { useNavigate } from 'react-router-dom';
import './Dashboard.css'; // Reusing dashboard styles for consistency

const About = () => {
    const navigate = useNavigate();

    return (
        <div className="dashboard about-page">
            <header className="dashboard-header">
                <div className="header-content">
                    <div className="header-title">
                        <button onClick={() => navigate('/')} className="back-btn" title="Back to Dashboard">
                            ← Back
                        </button>
                        <h1>About Quilly</h1>
                    </div>
                </div>
            </header>

            <main className="dashboard-main about-content" style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto', color: 'white' }}>
                <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
                    <img src="/logo.png" alt="Quilly Logo" style={{ width: '120px', marginBottom: '1rem' }} />
                    <h2 style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>Quilly</h2>
                    <p style={{ opacity: 0.7 }}>Voice to Text Desktop App - Talk more, type less</p>
                    <p style={{ opacity: 0.5 }}>Version 1.3.0</p>
                </div>

                {/* <div className="about-section" style={{ background: 'rgba(255,255,255,0.05)', padding: '2rem', borderRadius: '12px', marginBottom: '2rem' }}>
                    <h3 style={{ marginBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '0.5rem' }}>Credits</h3>
                    <p style={{ marginBottom: '1rem', lineHeight: '1.6' }}>
                        Created by <strong>Alfredo Rapetta</strong> at <a href="https://aips.studio" target="_blank" rel="noreferrer" style={{ color: '#646cff', textDecoration: 'none' }}>AIPS Studio</a>.
                    </p>
                    <p style={{ marginBottom: '1rem', lineHeight: '1.6' }}>
                        Quilly is an open source project brought to you by <a href="https://artrspro.com" target="_blank" rel="noreferrer" style={{ color: '#646cff', textDecoration: 'none' }}>ARTRs pro</a> & <a href="https://mypcfriends.com" target="_blank" rel="noreferrer" style={{ color: '#646cff', textDecoration: 'none' }}>MyPCFriends</a>.
                        Check out our other projects at <a href="https://aips.studio" target="_blank" rel="noreferrer" style={{ color: '#646cff', textDecoration: 'none' }}>AIPS Studio</a>.
                    </p>
                    <p style={{ fontSize: '0.9rem', opacity: 0.7, marginTop: '1rem' }}>
                        Licensed under the MIT License.
                    </p>
                </div> */}

                {/* <div className="about-section" style={{ background: 'rgba(255,255,255,0.05)', padding: '2rem', borderRadius: '12px' }}>
                    <h3 style={{ marginBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '0.5rem' }}>Support Development</h3>
                    <p style={{ marginBottom: '1.5rem', opacity: 0.9 }}>
                        Quilly is a passion project built to empower users with faster communication.
                        If it has saved you time or improved your workflow, consider supporting its future.
                        Your generosity helps AIPS Studio continue developing free, open-source AI tools for everyone.
                    </p>
                    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                        <a
                            href="https://github.com/sponsors/alfredorr-ARTRs-pro"
                            target="_blank"
                            rel="noreferrer"
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                background: '#ea4aaa',
                                color: 'white',
                                padding: '10px 20px',
                                borderRadius: '6px',
                                textDecoration: 'none',
                                fontWeight: 'bold'
                            }}
                        >
                            ❤️ Sponsor on GitHub
                        </a>
                        <a
                            href="https://www.paypal.com/donate/?hosted_button_id=EY723ETLSVH9G"
                            target="_blank"
                            rel="noreferrer"
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                background: '#0070ba',
                                color: 'white',
                                padding: '10px 20px',
                                borderRadius: '6px',
                                textDecoration: 'none',
                                fontWeight: 'bold'
                            }}
                        >
                            ☕ Donate via PayPal
                        </a>
                    </div>
                </div> */}
            </main>
        </div>
    );
};

export default About;
