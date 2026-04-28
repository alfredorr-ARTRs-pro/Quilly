import { useState, useEffect, useRef, useCallback } from 'react';
import './ReviewPopup.css';

const COUNTDOWN_SECONDS = 30;

export default function ReviewPopup() {
    const [text, setText] = useState('');
    const [intentLabel, setIntentLabel] = useState('');
    const [visible, setVisible] = useState(false);
    const [slideOut, setSlideOut] = useState(false);
    const [timeLeft, setTimeLeft] = useState(COUNTDOWN_SECONDS);
    const [locked, setLocked] = useState(false);
    const [copied, setCopied] = useState(false);
    // Review-first mode: show Accept & Paste / Dismiss buttons
    const [isReviewFirst, setIsReviewFirst] = useState(false);
    // Analyze mode: show copy/close only (output is never pasted)
    // Getter intentionally unused — state set by IPC handler for future-mode wiring
    const [, setIsAnalyze] = useState(false);

    const timerRef = useRef(null);
    const copiedTimerRef = useRef(null);
    const scrollResumeTimerRef = useRef(null);

    const clearCountdown = useCallback(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const startCountdown = useCallback(() => {
        clearCountdown();
        setTimeLeft(COUNTDOWN_SECONDS);
        timerRef.current = setInterval(() => {
            setTimeLeft((prev) => {
                if (prev <= 1) {
                    clearCountdown();
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    }, [clearCountdown]);

    // Currently unbound from JSX; kept for explicit-dismiss wiring
    const _handleDismiss = useCallback(() => {
        clearCountdown();
        setSlideOut(true);
        setTimeout(() => {
            window.electronAPI?.reviewPopupOutcome?.('dismissed');
        }, 300);
    }, [clearCountdown]);

    // When timeLeft reaches 0, signal timeout (distinct from manual dismiss)
    useEffect(() => {
        if (timeLeft === 0 && visible && !locked) {
            clearCountdown();
            // eslint-disable-next-line react-hooks/set-state-in-effect -- triggered by external countdown reaching zero
            setSlideOut(true);
            setTimeout(() => {
                window.electronAPI?.reviewPopupOutcome?.('timed_out');
            }, 300);
        }
    }, [timeLeft, visible, locked, clearCountdown]);

    useEffect(() => {
        if (!window.electronAPI?.onReviewPopupShow) return;

        const cleanup = window.electronAPI.onReviewPopupShow((data) => {
            const {
                text: newText,
                intentLabel: newLabel,
                isReviewFirst: newIsReviewFirst,
                isAnalyze: newIsAnalyze,
            } = data;
            setText(newText || '');
            setIntentLabel(newLabel || 'Processed');
            setIsReviewFirst(newIsReviewFirst || false);
            setIsAnalyze(newIsAnalyze || false);
            setVisible(true);
            setSlideOut(false);
            setLocked(false);
            setCopied(false);
            startCountdown();
        });

        return () => {
            if (typeof cleanup === 'function') cleanup();
            clearCountdown();
        };
    }, [startCountdown, clearCountdown]);

    const handleClose = useCallback(() => {
        clearCountdown();
        setSlideOut(true);
        setTimeout(() => {
            window.electronAPI?.reviewPopupOutcome?.('dismissed');
        }, 300);
    }, [clearCountdown]);

    const handleAcceptAndPaste = useCallback(async () => {
        clearCountdown();
        setSlideOut(true);
        window.electronAPI?.reviewPopupOutcome?.('accepted');
    }, [clearCountdown]);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Fallback to main process clipboard
            if (window.electronAPI?.reviewPopupCopyToClipboard) {
                await window.electronAPI.reviewPopupCopyToClipboard(text);
            }
        }
        setCopied(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 1000);
    }, [text]);

    const handleMouseEnter = useCallback(() => {
        if (!locked) {
            clearCountdown();
        }
    }, [locked, clearCountdown]);

    const handleMouseLeave = useCallback(() => {
        if (!locked) {
            // Clear any pending scroll-resume timer too
            if (scrollResumeTimerRef.current) {
                clearTimeout(scrollResumeTimerRef.current);
                scrollResumeTimerRef.current = null;
            }
            startCountdown();
        }
    }, [locked, startCountdown]);

    const handleClick = useCallback(() => {
        if (!locked) {
            setLocked(true);
            clearCountdown();
        }
    }, [locked, clearCountdown]);

    // Scroll handler: pause on scroll, resume 500ms after scrolling stops
    const handleWheel = useCallback(() => {
        if (locked) return;
        // Pause timer while scrolling
        clearCountdown();
        // Clear existing scroll-resume timer
        if (scrollResumeTimerRef.current) {
            clearTimeout(scrollResumeTimerRef.current);
        }
        // Restart countdown 500ms after last scroll event
        scrollResumeTimerRef.current = setTimeout(() => {
            scrollResumeTimerRef.current = null;
            if (!locked) {
                startCountdown();
            }
        }, 500);
    }, [locked, clearCountdown, startCountdown]);

    if (!visible) return null;

    const progressPercent = (timeLeft / COUNTDOWN_SECONDS) * 100;

    return (
        <div
            className={`review-popup ${slideOut ? 'slide-out' : 'slide-in'}`}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
        >
            <div className="review-popup-header">
                <span className="intent-label">{intentLabel}</span>
                <button
                    className="close-btn"
                    onClick={(e) => { e.stopPropagation(); handleClose(); }}
                    title="Close"
                >
                    &times;
                </button>
            </div>

            <div
                className="review-popup-body"
                onWheel={handleWheel}
            >
                {text}
            </div>

            <div className="review-popup-footer" onClick={(e) => e.stopPropagation()}>
                {/* Review-first mode: Accept & Paste + Dismiss + Copy */}
                {isReviewFirst && (
                    <>
                        <button
                            className="accept-btn"
                            onClick={handleAcceptAndPaste}
                        >
                            Accept &amp; Paste
                        </button>
                        <button
                            className="dismiss-btn"
                            onClick={handleClose}
                        >
                            Dismiss
                        </button>
                    </>
                )}

                {/* Copy button — always shown */}
                <button
                    className={`copy-btn${copied ? ' copied' : ''}`}
                    onClick={handleCopy}
                >
                    <span>{copied ? '\u2713' : '\u2398'}</span>
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                </button>

                {/* Progress bar — hidden when locked */}
                {!locked && (
                    <div className="progress-bar-track">
                        <div
                            className="progress-bar-fill"
                            style={{
                                width: `${progressPercent}%`,
                                transition: 'width 1s linear',
                            }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
