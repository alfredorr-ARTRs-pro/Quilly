import { useState, useEffect } from 'react';
import './FirstRunModal.css';

function FirstRunModal() {
    const [isOpen, setIsOpen] = useState(false);
    const [models, setModels] = useState([]);
    const [selectedModel, setSelectedModel] = useState('Xenova/whisper-medium');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        checkFirstRun();
    }, []);

    const checkFirstRun = async () => {
        try {
            if (!window.electronAPI?.getSettings) return;

            const settings = await window.electronAPI.getSettings();
            if (!settings.firstRunComplete) {
                const availableModels = await window.electronAPI.getAvailableModels();
                setModels(availableModels);
                setIsOpen(true);
            }
        } catch (err) {
            console.error('Failed to check first run:', err);
        }
    };

    const handleContinue = async () => {
        setIsLoading(true);
        setError(null);

        try {
            // Save selected model
            const result = await window.electronAPI.changeWhisperModel(selectedModel);
            if (!result.success) {
                throw new Error(result.error || 'Failed to set model');
            }

            // Mark first run as complete
            await window.electronAPI.setSetting('firstRunComplete', true);

            setIsOpen(false);
        } catch (err) {
            setError(err.message);
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="first-run-overlay">
            <div className="first-run-content">
                <div className="first-run-header">
                    <h1>Welcome to Quilly</h1>
                    <p>Choose your speech recognition model to get started</p>
                </div>

                <div className="first-run-body">
                    <p className="model-instructions">
                        Select a Whisper model based on your needs. Larger models provide better accuracy but require more disk space and processing time.
                    </p>

                    {error && <div className="error-message">{error}</div>}

                    <div className="model-list">
                        {models.map(model => (
                            <label
                                key={model.id}
                                className={`model-option ${selectedModel === model.id ? 'selected' : ''} ${isLoading ? 'disabled' : ''}`}
                            >
                                <input
                                    type="radio"
                                    name="firstRunModel"
                                    value={model.id}
                                    checked={selectedModel === model.id}
                                    onChange={() => setSelectedModel(model.id)}
                                    disabled={isLoading}
                                />
                                <div className="model-info">
                                    <span className="model-name">{model.name}</span>
                                    <span className="model-size">{model.size}</span>
                                    <span className="model-description">{model.description}</span>
                                </div>
                                {model.id === 'Xenova/whisper-medium' && (
                                    <span className="recommended-badge">Recommended</span>
                                )}
                            </label>
                        ))}
                    </div>

                    <p className="model-note">
                        The model will be downloaded automatically when you first transcribe audio. You can change this later in Settings.
                    </p>
                </div>

                <div className="first-run-footer">
                    <button
                        className="btn-primary"
                        onClick={handleContinue}
                        disabled={isLoading}
                    >
                        {isLoading ? 'Setting up...' : 'Get Started'}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default FirstRunModal;
