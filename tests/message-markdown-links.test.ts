import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Root } from 'mdast'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { remarkCumora } from '../src/lib/remarkCumora'

async function parse(markdown: string): Promise<Root> {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCumora)
  return await processor.run(processor.parse(markdown)) as Root
}

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(Markdown, {
    remarkPlugins: [remarkGfm, remarkBreaks, remarkCumora],
    skipHtml: true,
  }, markdown))
}

describe('chat Markdown links', () => {
  it('renders the reported Slack links with their complete labels and destinations', () => {
    const body = [
      '• <https://developers.openai.com/api/docs/guides/safety-best-practices|OpenAI Safety best practices>: 설명',
      '• <https://github.com/PostHog/posthog/issues/54450|PostHog 이슈 #54450> (10/8 완료)',
    ].join('\n')
    assert.equal(render(body), [
      '<p>• <a href="https://developers.openai.com/api/docs/guides/safety-best-practices">OpenAI Safety best practices</a>: 설명<br/>',
      '• <a href="https://github.com/PostHog/posthog/issues/54450">PostHog 이슈 #54450</a> (10/8 완료)</p>',
    ].join('\n'))
  })

  it('keeps Markdown markers, mentions and URLs in Slack link labels literal', () => {
    assert.equal(
      render('**<https://example.com|*Guide* @agent doc_123 https://other.test>**'),
      '<p><strong><a href="https://example.com">*Guide* @agent doc_123 https://other.test</a></strong></p>',
    )
  })

  it('decodes Slack entities without treating them as HTML or URL boundaries', () => {
    assert.equal(
      render('<https://example.com/search?a=1&amp;b=2|A &amp; B &lt;guide&gt;>'),
      '<p><a href="https://example.com/search?a=1&amp;b=2">A &amp; B &lt;guide&gt;</a></p>',
    )
  })

  it('preserves Slack syntax inside inline and fenced code', () => {
    const link = '<https://example.com|Guide>'
    assert.equal(
      render('`' + link + '`\n\n```\n' + link + '\n```'),
      '<p><code>&lt;https://example.com|Guide&gt;</code></p>\n<pre><code>&lt;https://example.com|Guide&gt;\n</code></pre>',
    )
  })

  it('keeps ordinary Markdown links and angle autolinks intact beside Slack links', () => {
    assert.equal(
      render('[Guide](https://example.com/a) <https://example.com/b> <https://example.com/c|한국어 안내>'),
      '<p><a href="https://example.com/a">Guide</a> <a href="https://example.com/b">https://example.com/b</a> <a href="https://example.com/c">한국어 안내</a></p>',
    )
  })

  it('does not turn Slack-style unsafe schemes into clickable destinations', () => {
    const html = render('<javascript:alert(1)|Click me> <data:text/html,hello|Open>')
    assert.ok(!/href="(?:javascript|data):/i.test(html))
  })

  it('keeps an existing Markdown link in charge of its label', () => {
    assert.equal(
      render('[<https://inner.test|Guide>](https://outer.test)'),
      '<p><a href="https://outer.test">&lt;https://inner.test|Guide&gt;</a></p>',
    )
  })

  it('renders adjacent Slack links in a list without swallowing surrounding prose', () => {
    assert.equal(
      render('- <https://example.com|One><https://example.org|Two>（설명）'),
      '<ul>\n<li><a href="https://example.com">One</a><a href="https://example.org">Two</a>（설명）</li>\n</ul>',
    )
  })

  it('accepts the escaped pipe required in a GFM table cell', () => {
    assert.equal(
      render('| Link |\n| --- |\n| <https://example.com\\|Guide> |'),
      '<table><thead><tr><th>Link</th></tr></thead><tbody><tr><td><a href="https://example.com">Guide</a></td></tr></tbody></table>',
    )
  })

  it('repairs a bold URL followed immediately by CJK prose', async () => {
    const tree = await parse('浏览器打开 **http://127.0.0.1:4182**（本机 preview）')
    const paragraph = tree.children[0]
    assert.equal(paragraph.type, 'paragraph')
    if (paragraph.type !== 'paragraph') return

    assert.deepEqual(paragraph.children.map((node) => node.type), ['text', 'strong', 'text', 'text'])
    const strong = paragraph.children[1]
    assert.equal(strong.type, 'strong')
    if (strong.type !== 'strong') return
    const link = strong.children[0]
    assert.equal(link.type, 'link')
    if (link.type !== 'link') return
    assert.equal(link.url, 'http://127.0.0.1:4182')
    assert.equal(link.children[0].type === 'text' ? link.children[0].value : null, link.url)
    const visibleText = paragraph.children
      .filter((node) => node.type === 'text')
      .map((node) => node.value)
      .join('')
    assert.equal(visibleText, '浏览器打开 （本机 preview）')
    assert.ok(!visibleText.includes('**'))
  })

  it('keeps a literal URL as one non-nested link', async () => {
    const tree = await parse('打开 https://example.com/path')
    const paragraph = tree.children[0]
    assert.equal(paragraph.type, 'paragraph')
    if (paragraph.type !== 'paragraph') return
    const link = paragraph.children.find((node) => node.type === 'link')
    assert.ok(link && link.type === 'link')
    assert.deepEqual(link.children.map((node) => node.type), ['text'])
  })

  it('stops a literal URL at CJK punctuation', async () => {
    const tree = await parse('详见 https://example.com/path（说明）')
    const paragraph = tree.children[0]
    assert.equal(paragraph.type, 'paragraph')
    if (paragraph.type !== 'paragraph') return
    const link = paragraph.children.find((node) => node.type === 'link')
    assert.ok(link && link.type === 'link')
    assert.equal(link.url, 'https://example.com/path')
  })

  it('does not alter an explicit Markdown link', async () => {
    const tree = await parse('[本机预览](http://127.0.0.1:4182)')
    const paragraph = tree.children[0]
    assert.equal(paragraph.type, 'paragraph')
    if (paragraph.type !== 'paragraph') return
    const link = paragraph.children[0]
    assert.equal(link.type, 'link')
    if (link.type !== 'link') return
    assert.equal(link.url, 'http://127.0.0.1:4182')
    assert.equal(link.children[0].type === 'text' ? link.children[0].value : null, '本机预览')
  })
})
