import React from 'react';
import { useNavigate } from 'react-router-dom';
import './Dashboard.css'; // Reusing dashboard styles for consistency
import AboutSection from '../components/AboutSection';

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
                <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
                    {/* Relative path — an absolute /logo.png resolves to the filesystem
                        root when the packaged app loads index.html over file:// */}
                    <img src="logo.png" alt="Quilly Logo" style={{ width: '120px', marginBottom: '1rem' }} />
                    <h2 style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>Quilly</h2>
                    <p style={{ opacity: 0.7 }}>Voice to Text Desktop App - Talk more, type less</p>
                </div>

                <AboutSection />
            </main>
        </div>
    );
};

export default About;
