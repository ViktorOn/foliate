const webpubFromText = async uri => {
    const res = await fetch(uri)
    const data = await res.text()

    const chapters = data.split(/(\r?\n){3,}/g)
        .filter(x => !/^\r?\n$/.test(x))
        .map(c => {
            const ps = c.split(/(\r?\n){2}/g)
                .filter(x => !/^\r?\n$/.test(x))
            const blob = new Blob(
                [ps.map(p => `<p>${p}</p>`).join('')],
                { type: 'text/html' })
            const url = URL.createObjectURL(blob)
            return {
                href: url,
                type: 'text/html',
                title: ps[0].replace(/\r?\n/g, '')
            }
        })

    return {
        metadata: {},
        links: [],
        readingOrder: chapters,
        toc: chapters,
        resources: []
    }
}

const XLINK_NS = 'http://www.w3.org/1999/xlink'

const webpubFromFB2Zip = async uri => {
    let zip = new JSZip()
    const res = await fetch(uri)
    const data = await res.blob()
    zip = await JSZip.loadAsync(data)
    const text = await zip.file(/.fb2$/)[0].async('string')
    let doc = new DOMParser().parseFromString(text, 'text/xml')
    return processFB2(doc)
}

const webpubFromFB2 = async uri => {
    const res = await fetch(uri)
    const buffer = await res.arrayBuffer()
    const decoder = new TextDecoder('utf-8')
    const data = decoder.decode(buffer)
    let doc = new DOMParser().parseFromString(data, 'text/xml')
    if (doc.xmlEncoding !== 'utf-8') {
        const decoder = new TextDecoder(doc.xmlEncoding)
        const data = decoder.decode(buffer)
        doc = new DOMParser().parseFromString(data, 'text/xml')
    }
    return processFB2(doc)
}

const fb2ToHtml = (x, h, getImage) => {
    Array.from(x.querySelectorAll('title'))
        .forEach(el => el.parentNode.replaceChild(h(`<h2>${el.textContent}</h2>`), el))
    Array.from(x.querySelectorAll('subtitle'))
        .forEach(el => el.parentNode.replaceChild(h(`<h3>${el.textContent}</h3>`), el))
    Array.from(x.querySelectorAll('image'))
        .forEach(el => el.parentNode.replaceChild(h(`<img src="${getImage(el).data}">`), el))
    Array.from(x.querySelectorAll('empty-line'))
        .forEach(el => el.parentNode.replaceChild(h(`<hr class="empty-line">`), el))
    Array.from(x.querySelectorAll('style'))
        .forEach(el => usurp(el))
    Array.from(x.querySelectorAll('emphasis'))
        .forEach(el => el.innerHTML = `<em>${el.innerHTML}</em>`)
    Array.from(x.querySelectorAll('poem, epigraph, cite'))
        .forEach(el => el.parentNode.replaceChild(h(`<blockquote>${el.innerHTML}</blockquote>`), el))
    Array.from(x.querySelectorAll('stanza'))
        .forEach(el => el.parentNode.replaceChild(h(`<p>${el.innerHTML}</p>`), el))
    Array.from(x.querySelectorAll('text-author'))
        .forEach(el => el.parentNode.replaceChild(h(`<p class="text-author">${el.innerHTML}</p>`), el))
    Array.from(x.querySelectorAll('v'))
        .forEach(el => { el.innerHTML = `${el.innerHTML}<br>`; usurp(el) })
    Array.from(x.querySelectorAll('a'))
        .forEach(el => el.innerHTML = `<sup>${el.innerHTML}</sup>`)
    return x
}

let fb2doc // useful for debugging
const processFB2 = doc => {
    fb2doc = doc
    const $ = doc.querySelector.bind(doc)
    const $$ = doc.querySelectorAll.bind(doc)
    const h = html => {
        const el = doc.createElement('template')
        el.innerHTML = html
        return el.firstChild
    }

    // FIXME: elements could be null
    const title = $('book-title').textContent
    const identifier = $('id').textContent
    const description = $('title-info annotation').textContent
    const language = $('lang').textContent

    const getImage = image => {
        const id = image.getAttributeNS(XLINK_NS, 'href').replace(/^#/, '')
        const bin = doc.getElementById(id)
        const type = bin.getAttribute('content-type')
        return {
            content: bin.textContent,
            data: `data:${type};base64,${bin.textContent}`,
            type
        }
    }

    try {
        const { content } = getImage($('coverpage image'))
        dispatch({ type: 'cover', payload: content })
    } catch (e) {}


    const stylesheet = `
        body > img, section > img {
            display: block;
            margin: auto;
        }
        h1 {
            text-align: center;
        }
        .text-author {
            text-align: right;
        }
        .text-author:before {
            content: "—";
        }
        .empty-line {
            padding: 0;
            border: none;
            text-align: center;
            opacity: 0.3;
        }
        .empty-line:before {
            content: "⁂";
        }
    `
    const styleBlob = new Blob([stylesheet], { type: 'text/css' })
    const styleUrl = URL.createObjectURL(styleBlob)

    const notes = new Map()
    const sections = Array.from($$('body > *')).map(x => {
        const id = x.getAttribute('id')
        if (notes.has(id)) return notes.get(id)

        let sectionTitle = x.querySelector('title')
        if (x.tagName === 'image') x.innerHTML = `<img src="${getImage(x).data}">`
        if (x.tagName === 'title') {
            sectionTitle = x
            Array.from(x.querySelectorAll('p'))
                .forEach(el => el.parentNode.replaceChild(h(`<h1>${el.textContent}</h1>`), el))
        }

        Array.from(x.querySelectorAll('a'))
            .forEach(el => {
                const href = el.getAttributeNS(XLINK_NS, 'href')
                if (href) {
                    const id = href.replace(/^#/, '')
                    const note = doc.getElementById(id)
                    let sectionTitle = note.querySelector('title')
                    fb2ToHtml(note, h, getImage)
                    const html = `<!DOCTYPE html>
                        <link href="${styleUrl}" rel="stylesheet">
                        <section id="${id}">
                            ${note.innerHTML}
                        </section>`
                    if (notes.has(id)) {
                        el.setAttribute('href', notes.get(id).href + '#' + id)
                    } else {
                        const blob = new Blob([html], { type: 'text/html' })
                        const url = URL.createObjectURL(blob)
                        const item = {
                            href: url,
                            type: 'text/html',
                            title: (sectionTitle ? sectionTitle.textContent : title)
                        }
                        notes.set(id, item)
                        el.setAttribute('href', url + '#' + id)
                    }
                }
            })

        fb2ToHtml(x, h, getImage)
        const html = `<!DOCTYPE html>
            <link href="${styleUrl}" rel="stylesheet">
            ${x.innerHTML}`
        const blob = new Blob([html], { type: 'text/html' })
        const url = URL.createObjectURL(blob)

        return {
            href: url,
            type: 'text/html',
            title: (sectionTitle ? sectionTitle.textContent : title)
                .trim().replace(/\r?\n/g, ' ')
        }
    })

    return {
        metadata: {
            title,
            identifier,
            description,
            language
        },
        links: [],
        readingOrder: sections,
        toc: sections,
        resources: [
            { href: styleUrl, type: 'text/css' }
        ]
    }
}