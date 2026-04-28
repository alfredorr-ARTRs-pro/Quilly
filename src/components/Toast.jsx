/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect, useCallback } from 'react';
import './Toast.css';

// Toast item component
function ToastItem({ id, message, type, onRemove }) {
    const [isExiting, setIsExiting] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            setIsExiting(true);
            setTimeout(() => onRemove(id), 300); // Wait for exit animation
        }, type === 'error' ? 5000 : 3000); // Errors stay longer

        return () => clearTimeout(timer);
    }, [id, type, onRemove]);

    const handleClick = () => {
        setIsExiting(true);
        setTimeout(() => onRemove(id), 300);
    };

    return (
        <div
            className={`toast toast-${type} ${isExiting ? 'toast-exit' : ''}`}
            onClick={handleClick}
        >
            <span className="toast-icon">
                {type === 'success' && '✓'}
                {type === 'error' && '✕'}
                {type === 'info' && 'ℹ'}
                {type === 'loading' && '⟳'}
            </span>
            <span className="toast-message">{message}</span>
        </div>
    );
}

// Toast container with context
let toastId = 0;
let addToastGlobal = null;

export function ToastContainer() {
    const [toasts, setToasts] = useState([]);

    const addToast = useCallback((message, type = 'info') => {
        const id = ++toastId;
        setToasts(prev => [...prev, { id, message, type }]);
        return id;
    }, []);

    const removeToast = useCallback((id) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    const updateToast = useCallback((id, message, type) => {
        setToasts(prev => prev.map(t =>
            t.id === id ? { ...t, message, type } : t
        ));
    }, []);

    // Expose functions globally
    useEffect(() => {
        addToastGlobal = { addToast, removeToast, updateToast };
        return () => { addToastGlobal = null; };
    }, [addToast, removeToast, updateToast]);

    return (
        <div className="toast-container">
            {toasts.map(toast => (
                <ToastItem
                    key={toast.id}
                    id={toast.id}
                    message={toast.message}
                    type={toast.type}
                    onRemove={removeToast}
                />
            ))}
        </div>
    );
}

// Helper functions to show toasts
export const toast = {
    success: (message) => addToastGlobal?.addToast(message, 'success'),
    error: (message) => addToastGlobal?.addToast(message, 'error'),
    info: (message) => addToastGlobal?.addToast(message, 'info'),
    loading: (message) => addToastGlobal?.addToast(message, 'loading'),
    update: (id, message, type) => addToastGlobal?.updateToast(id, message, type),
    remove: (id) => addToastGlobal?.removeToast(id),
};

export default ToastContainer;
