import React, { memo } from 'react'

// Splits content into text/code segments and renders with basic formatting.
// Kept minimal — no heavy markdown parsers.
const MessageContent = memo(({ content = '', codeStyle = {}, textStyle = {} }) => {
  const segments = content.split(/(```[\s\S]*?```)/g)

  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, ...textStyle }}>
      {segments.map((seg, i) => {
        if (seg.startsWith('```')) {
          const inner = seg.slice(3, -3)
          const nl = inner.indexOf('\n')
          const lang = nl > -1 ? inner.slice(0, nl).trim() : ''
          const code = nl > -1 ? inner.slice(nl + 1) : inner
          return (
            <pre key={i} style={{
              fontFamily: '"DM Mono", "Space Mono", monospace',
              fontSize: '0.82em',
              background: 'rgba(0,0,0,0.18)',
              border: '1px solid rgba(255,255,255,0.08)',
              padding: '12px 14px',
              borderRadius: '6px',
              overflow: 'auto',
              margin: '10px 0',
              ...codeStyle,
            }}>
              {lang && (
                <div style={{ opacity: 0.5, fontSize: '0.75em', marginBottom: '6px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{lang}</div>
              )}
              <code style={{ fontFamily: 'inherit' }}>{code}</code>
            </pre>
          )
        }
        // Inline code
        const parts = seg.split(/(`[^`\n]+`)/g)
        return (
          <span key={i}>
            {parts.map((p, j) =>
              p.startsWith('`') && p.endsWith('`') && p.length > 2 ? (
                <code key={j} style={{
                  fontFamily: '"DM Mono", monospace',
                  fontSize: '0.85em',
                  background: 'rgba(0,0,0,0.15)',
                  padding: '1px 5px',
                  borderRadius: '3px',
                  ...codeStyle,
                }}>{p.slice(1, -1)}</code>
              ) : (
                <span key={j}>{p}</span>
              )
            )}
          </span>
        )
      })}
    </div>
  )
})

export default MessageContent
