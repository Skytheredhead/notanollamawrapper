import React, { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const MessageContent = memo(({ content = '' }) => (
  <div className="messageContent">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
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
      }}
    >
      {content}
    </ReactMarkdown>
  </div>
))

export default MessageContent
