import React, { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function extractTaggedSegments(raw) {
  const text = String(raw || '')

  // Gemma "thinking mode" (common in Ollama): <think> ... </think>
  const thinkTag = /<think>([\s\S]*?)<\/think>/i
  const mThink = text.match(thinkTag)
  if (mThink) {
    const thinking = (mThink[1] || '').trim()
    const answer = text.replace(thinkTag, '').trim()
    return { thinking, answer }
  }

  // Some runtimes emit <analysis>...</analysis> blocks (XML-ish style).
  const analysisTag = /<analysis>([\s\S]*?)<\/analysis>/i
  const mAnalysis = text.match(analysisTag)
  if (mAnalysis) {
    const thinking = (mAnalysis[1] || '').trim()
    const answer = text.replace(analysisTag, '').trim()
    return { thinking, answer }
  }

  // GPT-OSS / Harmony format: <|channel|>analysis<|message|>...<|end|> ... <|channel|>final<|message|>...<|end|>
  const harmony = /<\|channel\|>(analysis|final|commentary)<\|message\|>([\s\S]*?)<\|end\|>/gi
  let match = null
  let sawAny = false
  const analysisParts = []
  const visibleParts = []
  while ((match = harmony.exec(text))) {
    sawAny = true
    const channel = String(match[1] || '').toLowerCase()
    const body = String(match[2] || '').trim()
    if (!body) continue
    if (channel === 'analysis') analysisParts.push(body)
    else visibleParts.push(body)
  }
  if (sawAny) {
    return {
      thinking: analysisParts.join('\n\n').trim(),
      answer: visibleParts.join('\n\n').trim(),
    }
  }

  // Very common “tag leak” from some servers / templates:
  // <channel>analysis</channel><message>...</message> (or without explicit <message> wrapper).
  const xmlChannelMessage = /<channel>\s*(analysis|final|commentary)\s*<\/channel>\s*(?:<message>)?([\s\S]*?)(?:<\/message>)?(?=(?:<channel>\s*(analysis|final|commentary)\s*<\/channel>)|$)/gi
  let xml = null
  let sawXml = false
  const xmlAnalysis = []
  const xmlVisible = []
  while ((xml = xmlChannelMessage.exec(text))) {
    sawXml = true
    const channel = String(xml[1] || '').toLowerCase()
    const body = String(xml[2] || '').trim()
    if (!body) continue
    if (channel === 'analysis') xmlAnalysis.push(body)
    else xmlVisible.push(body)
  }
  if (sawXml) {
    return {
      thinking: xmlAnalysis.join('\n\n').trim(),
      answer: xmlVisible.join('\n\n').trim(),
    }
  }

  // Cleanup for partial/buggy token leaks.
  const cleaned = text
    .replace(/<\|start\|>.*?(?=<\|message\|>|$)/gis, '')
    .replace(/<\|message\|>/g, '')
    .replace(/<\|end\|>/g, '')
    .replace(/<\|channel\|>(analysis|final|commentary)/gi, '')
    .replace(/<\/?channel>/gi, '')
    .replace(/<\/?message>/gi, '')
    .trim()

  return { thinking: '', answer: cleaned }
}

const markdownComponents = {
  a({ children, ...props }) {
    return <a {...props} target="_blank" rel="noreferrer">{children}</a>
  },
  pre({ children, ...props }) {
    return <pre className="markdownCodeBlock" {...props}>{children}</pre>
  },
  code({ className, children, ...props }) {
    const blockClass = className ? `markdownCode ${className}` : 'markdownInlineCode'
    return <code className={blockClass} {...props}>{children}</code>
  },
}

const MessageContent = memo(({ content = '' }) => {
  const { thinking, answer } = useMemo(() => extractTaggedSegments(content), [content])

  return (
    <div className="messageContent">
      {thinking ? (
        <details className="thinkingBlock">
          <summary className="thinkingSummary">Thinking</summary>
          <div className="thinkingBody" aria-label="Model reasoning">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {thinking}
            </ReactMarkdown>
          </div>
        </details>
      ) : null}

      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {answer}
      </ReactMarkdown>
    </div>
  )
})

export default MessageContent
