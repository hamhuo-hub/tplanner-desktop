import { useState } from 'react'
import { ArrowRight, CalendarDays, Eye, EyeOff, LockKeyhole } from 'lucide-react'
import { DEFAULT_SERVER_URL, clearSession, saveSessionConfig, verifySession } from '../syncV5/session.js'
import './LoginScreen.css'

/**
 * Session setup for the single V5 endpoint: server address + bearer token.
 *
 * There is no account/PIN concept in the V5 contract — the token the server requires is the
 * only credential. The form verifies against `GET /tplanner/v5/health` before persisting,
 * so the app never claims to be connected to a server it cannot reach.
 */
function LoginScreen({ onConnected, onLogout }) {
    const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL)
    const [token, setToken] = useState('')
    const [showToken, setShowToken] = useState(false)
    const [remember, setRemember] = useState(true)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [error, setError] = useState('')

    const handleSubmit = async (event) => {
        event.preventDefault()
        if (!serverUrl.trim() || !token.trim()) {
            setError('请输入服务器地址和访问令牌')
            return
        }
        setError('')
        setIsSubmitting(true)
        try {
            const health = await verifySession({ serverUrl, token })
            saveSessionConfig({ serverUrl: health.baseUrl, token, remember })
            onConnected?.({ serverUrl: health.baseUrl, token })
        } catch (requestError) {
            setError(requestError?.message || '无法连接同步服务，请检查地址与令牌')
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleForget = () => {
        clearSession()
        onLogout?.()
    }

    return (
        <main className="login-shell">
            <section className="login-visual" aria-label="建筑背景">
                <div className="login-window-controls" aria-hidden="true">
                    <span className="login-window-dot login-window-dot--red" />
                    <span className="login-window-dot login-window-dot--yellow" />
                    <span className="login-window-dot login-window-dot--green" />
                </div>

                <div className="login-visual-shade" />
                <div className="login-brand">
                    <span className="login-brand-mark"><CalendarDays size={20} strokeWidth={1.8} /></span>
                    <span>tPlanner</span>
                </div>

                <div className="login-visual-copy">
                    <p className="login-eyebrow">SYNC V5 · JCAL CANONICAL</p>
                    <h1>让每一段时间，<br />都有自己的秩序。</h1>
                    <p>本地先落盘，中央再确认。</p>
                </div>

                <p className="login-image-credit">PRIVATE WORKSPACE · 2026</p>
            </section>

            <section className="login-panel">
                <div className="login-card tp-panel">
                    <header className="login-card-header">
                        <span className="login-lock"><LockKeyhole size={20} strokeWidth={1.8} /></span>
                        <p>同步服务器</p>
                    </header>

                    <div className="login-card-copy">
                        <p className="login-card-kicker">CONNECT</p>
                        <h2>连接你的工作空间</h2>
                        <p>填写同步服务地址与访问令牌。令牌只会以 Authorization 头发送。</p>
                    </div>

                    <form className="login-form" onSubmit={handleSubmit} noValidate>
                        <label className="login-field">
                            <span>服务器地址</span>
                            <input
                                className="tp-field"
                                type="url"
                                value={serverUrl}
                                onChange={(event) => setServerUrl(event.target.value)}
                                placeholder="https://sync.hamhuo.top"
                                autoComplete="url"
                                autoFocus
                            />
                        </label>

                        <label className="login-field">
                            <span>访问令牌</span>
                            <span className="login-password-wrap">
                                <input
                                    className="tp-field"
                                    type={showToken ? 'text' : 'password'}
                                    value={token}
                                    onChange={(event) => setToken(event.target.value)}
                                    placeholder="Bearer 令牌"
                                    autoComplete="off"
                                />
                                <button
                                    type="button"
                                    className="login-password-toggle"
                                    onClick={() => setShowToken((visible) => !visible)}
                                    aria-label={showToken ? '隐藏令牌' : '显示令牌'}
                                >
                                    {showToken ? <EyeOff size={18} /> : <Eye size={18} />}
                                </button>
                            </span>
                        </label>

                        <div className="login-form-meta">
                            <label className="login-remember">
                                <input
                                    type="checkbox"
                                    checked={remember}
                                    onChange={(event) => setRemember(event.target.checked)}
                                />
                                <span>记住此设备</span>
                            </label>
                            {onLogout && (
                                <button type="button" className="login-text-button" onClick={handleForget}>清除已保存的配置</button>
                            )}
                        </div>

                        {error && <p className="login-error" role="alert">{error}</p>}

                        <button type="submit" className="login-submit btn btn--primary" disabled={isSubmitting}>
                            <span>{isSubmitting ? '正在验证…' : '连接并进入'}</span>
                            <ArrowRight size={18} />
                        </button>
                    </form>

                    <footer className="login-card-footer">
                        <span className="login-status-dot" />
                        本机 IndexedDB（tplanner-v5）是本地权威副本
                    </footer>
                </div>

                <p className="login-panel-footer">tPlanner · Sync V5</p>
            </section>
        </main>
    )
}

export default LoginScreen
