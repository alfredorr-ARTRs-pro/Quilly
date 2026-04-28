// Storage service for persisting recordings and history
// Uses electron-store for JSON-based persistence

const STORAGE_KEY = 'recordings';

class StorageService {
    constructor() {
        this.recordings = this.load();
    }

    load() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (err) {
            console.error('Failed to load recordings:', err);
            return [];
        }
    }

    save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.recordings));
        } catch (err) {
            console.error('Failed to save recordings:', err);
        }
    }

    getAll() {
        return [...this.recordings];
    }

    getById(id) {
        return this.recordings.find(r => r.id === id);
    }

    add(recording) {
        const generateId = () => {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                return crypto.randomUUID();
            }
            return 'req-' + Date.now() + '-' + Math.random().toString(36).substring(2, 11);
        };

        const newRecording = {
            id: generateId(),
            name: recording.name || 'Untitled Recording',
            date: new Date().toISOString().split('T')[0],
            duration: recording.duration || '0:00',
            status: 'draft',
            transcription: null,
            audioPath: recording.audioPath || null,
            createdAt: Date.now(),
            ...recording,
        };
        this.recordings.unshift(newRecording);
        this.save();
        return newRecording;
    }

    update(id, updates) {
        const index = this.recordings.findIndex(r => r.id === id);
        if (index !== -1) {
            this.recordings[index] = { ...this.recordings[index], ...updates };
            this.save();
            return this.recordings[index];
        }
        return null;
    }

    delete(id) {
        this.recordings = this.recordings.filter(r => r.id !== id);
        this.save();
    }

    deleteMultiple(ids) {
        const idSet = new Set(ids);
        this.recordings = this.recordings.filter(r => !idSet.has(r.id));
        this.save();
    }

    clearAll() {
        this.recordings = [];
        this.save();
    }

    search(query) {
        const lower = query.toLowerCase();
        return this.recordings.filter(r =>
            r.name.toLowerCase().includes(lower) ||
            (r.transcription && r.transcription.toLowerCase().includes(lower))
        );
    }
}

// Singleton instance
const storageService = new StorageService();

export default storageService;
