/**
 * 全网大数据搜索引擎 (Big Data Web Search Engine)
 * 
 * 检索层次（4层递进）：
 * L1: 全网聚合搜索 — 并行检索 Bing + 百度 + 搜狗 → 提取摘要 → 深度网页抓取
 * L2: Wikipedia API — 多端点轮询（中文→英文）
 * L3: 百度百科 — CORS代理 → 搜索建议 → 直接链接
 * L4: DuckDuckGo — Instant Answer API 兜底
 * 
 * 核心技术：
 * - CORS代理池（自动轮换，提高可靠性）
 * - 多引擎搜索结果解析（Bing/百度/搜狗专用解析器）
 * - 网页正文智能提取（可读性算法）
 * - TF-IDF关键词匹配 + 智能片段筛选
 * - 多级缓存
 */

const WebSearchEngine = {
    searchCache: new Map(),

    // 多个 Wikipedia API 端点（依次尝试直到成功）
    wikiEndpoints: [
        'https://zh.wikipedia.org/w/api.php',          // 中文维基官方
        // 不再使用英文维基，避免返回全英文内容
    ],

    // 当前使用的端点索引
    _currentEndpoint: 0,

    /**
     * 获取下一个可用的 Wikipedia 端点
     */
    _getWikiBase() {
        return this.wikiEndpoints[this._currentEndpoint] || this.wikiEndpoints[0];
    },

    /**
     * 尝试下一个镜像端点
     */
    _tryNextEndpoint() {
        this._currentEndpoint++;
        if (this._currentEndpoint >= this.wikiEndpoints.length) {
            this._currentEndpoint = 0;
        }
        return this._getWikiBase();
    },

    /**
     * 移除问题中的语气词，提取核心搜索关键词
     */
    extractSearchQuery(question) {
        let q = question.replace(/[吗呢吧呀啊么哦？?！!。，,、\s]/g, ' ').trim();
        const removeWords = [
            '请问', '请', '告诉我', '我想', '知道', '一下', '这个', '那个',
            '讲讲', '介绍', '说说', '是什么', '什么是', '可以', '能不能', '给我',
            '帮我', '关于', '有关', '来说', '有哪些', '哪些', '怎样', '如何',
            '为什么', '是不是', '有没有', '详细', '具体', '说明', '多少个',
            '什么', '我', '你', '它', '他', '她', '的', '了', '在', '是', '有', '和',
            '就', '不', '都', '要', '去', '会', '着', '没有', '看', '好', '也', '很', '到'
        ];
        removeWords.sort((a, b) => b.length - a.length);
        removeWords.forEach(w => {
            q = q.replace(new RegExp(w, 'g'), ' ');
        });
        q = q.replace(/\s+/g, ' ').trim();
        return q || question;
    },

    /**
     * 通用 Wikipedia API 请求
     */
    async _wikiFetch(params, description) {
        // 尝试所有可用端点
        for (let attempt = 0; attempt < this.wikiEndpoints.length; attempt++) {
            const base = this._getWikiBase();
            console.log(`[WebSearch] ${description} (尝试 #${attempt + 1}: ${base})`);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);

            try {
                const url = `${base}?${params}`;
                const res = await fetch(url, { signal: controller.signal });
                clearTimeout(timeout);

                if (!res.ok) {
                    console.warn(`[WebSearch] ${base} 返回 ${res.status}`);
                    this._tryNextEndpoint();
                    continue;
                }

                const data = await res.json();
                console.log(`[WebSearch] ✓ ${base} 请求成功`);
                return data;
            } catch (e) {
                clearTimeout(timeout);
                console.warn(`[WebSearch] ${base} 请求失败: ${e.name} - ${e.message}`);
                this._tryNextEndpoint();
            }
        }

        console.warn(`[WebSearch] ✗ 所有端点均失败: ${description}`);
        return null;
    },

    /**
     * 搜索维基百科条目
     */
    async searchWikipedia(query) {
        const params = new URLSearchParams({
            action: 'query',
            list: 'search',
            srsearch: query,
            format: 'json',
            srlimit: '5',
            origin: '*'
        });

        const data = await this._wikiFetch(params.toString(), `搜索: "${query}"`);
        if (!data || !data.query) return [];

        const results = (data.query.search || []).filter(r => r.title && !r.title.includes(':'));
        console.log(`[WebSearch] 找到 ${results.length} 个Wikipedia条目:`, results.map(r => r.title));
        return results;
    },

    /**
     * 获取维基百科条目摘要（只保留中文）
     */
    async getWikipediaExtract(pageTitle) {
        const params = new URLSearchParams({
            action: 'query',
            prop: 'extracts',
            exintro: '1',
            explaintext: '1',
            titles: pageTitle,
            format: 'json',
            origin: '*'
        });

        const data = await this._wikiFetch(params.toString(), `获取摘要: "${pageTitle}"`);
        if (!data) return { extract: '', title: pageTitle };

        const pages = data.query?.pages || {};
        const page = Object.values(pages)[0];
        if (!page || page.missing) {
            console.warn(`[WebSearch] 条目不存在: "${pageTitle}"`);
            return { extract: '', title: pageTitle };
        }

        const extract = page.extract || '';
        // 检查是否为中文内容，英文维基返回的摘要直接丢弃
        if (extract.length > 20 && !this._isChineseContent(extract, 0.08)) {
            console.warn(`[WebSearch] 条目 "${pageTitle}" 非中文内容，丢弃 (中文占比=${(this._chineseRatio(extract)*100).toFixed(0)}%)`);
            return { extract: '', title: pageTitle };
        }
        console.log(`[WebSearch] 摘要长度: ${extract.length} 字符`);
        return { extract, title: page.title || pageTitle };
    },

    /**
     * 提取与问题最相关的句子片段
     */
    extractRelevantSnippet(text, question, maxLen) {
        maxLen = maxLen || 280;
        if (!text || text.length <= maxLen) return text;

        const keywords = this._extractKeywords(question);

        // 按句号、分号、换行分割
        const sentences = text.split(/[。；\n]/).filter(s => s.trim().length > 5);

        // 为每句打分
        const scored = sentences.map((s, i) => {
            let score = 0;
            for (const kw of keywords) {
                if (s.includes(kw)) {
                    score += kw.length * 2;
                    // 句首匹配加分
                    if (s.indexOf(kw) < 10) score += kw.length;
                }
            }
            // 靠前的句子稍加分
            if (i < 2) score += 3;
            return { text: s.trim(), score, index: i };
        });

        scored.sort((a, b) => b.score - a.score);

        // 取前三高分的句子（但保持原顺序）
        const selected = scored.slice(0, 4).sort((a, b) => a.index - b.index);
        let result = '';
        for (const s of selected) {
            const candidate = result + (result ? '。' : '') + s.text;
            if (candidate.length <= maxLen) {
                result = candidate;
            } else {
                break;
            }
        }
        if (result) return result + '。';

        // 无匹配时返回开头
        return sentences[0] || text.substring(0, maxLen);
    },

    _extractKeywords(text) {
        const clean = text.replace(/[，,。.！!？?\s、：:；;（）()「」『』""''【】《》—\-…~]/g, '');
        const words = new Set();
        for (let i = 0; i < clean.length; i++) {
            if (clean[i] && !/[的了吗呢吧呀啊]/g.test(clean[i])) words.add(clean[i]);
            if (i < clean.length - 1) words.add(clean.substring(i, i + 2));
            if (i < clean.length - 2) words.add(clean.substring(i, i + 3));
        }
        return Array.from(words).filter(w => w.length >= 1);
    },

    // ============================================================
    //  全网大数据搜索引擎 (Big Data Web Search)
    //  通过CORS代理突破浏览器限制，同时检索多个搜索引擎
    //  提取搜索结果摘要 + 深度抓取目标网页正文
    // ============================================================

    // CORS代理池（自动轮换，提高成功率）
        // CORS代理池（自动轮换，提高成功率）
    proxyPool: [
        { url: 'https://api.allorigins.win/raw?url=', timeout: 8000 },
        { url: 'https://api.codetabs.com/v1/proxy?quest=', timeout: 8000 },
        { url: 'https://corsproxy.io/?', timeout: 8000 },
        { url: 'https://thingproxy.freeboard.io/fetch/', timeout: 7000 },
        { url: 'https://cors-anywhere.herokuapp.com/', timeout: 8000 },
        // 新增更多高可用性代理
        { url: 'https://api.microlink.io/?url=', timeout: 10000 },
        { url: 'https://r.jina.ai/', timeout: 10000 },
        { url: 'https://textise.net/showText.aspx?strURL=', timeout: 8000 },
        { url: 'https://www.textise.net/i.aspx?strURL=', timeout: 8000 },
        { url: 'https://cors.bridged.cc/', timeout: 8000 },
        { url: 'https://proxy.cors.sh/', timeout: 8000 },
    ],

    _proxyIndex: 0,

    /** 通过CORS代理池获取网页内容 */
    async _fetchViaProxy(targetUrl, description) {
        const startIdx = this._proxyIndex;
        for (let attempt = 0; attempt < this.proxyPool.length; attempt++) {
            const proxy = this.proxyPool[(startIdx + attempt) % this.proxyPool.length];
            this._proxyIndex = (startIdx + attempt + 1) % this.proxyPool.length;
            const fullUrl = proxy.url + encodeURIComponent(targetUrl);

            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), proxy.timeout);
            try {
                console.log(`[Proxy] ${description} → ${proxy.url.substring(0, 35)}...`);
                const res = await fetch(fullUrl, { signal: ctrl.signal });
                clearTimeout(t);
                if (res.ok) {
                    const text = await res.text();
                    console.log(`[Proxy] ✓ 获取成功 (${text.length} 字符)`);
                    return text;
                }
                console.warn(`[Proxy] HTTP ${res.status}`);
            } catch (e) {
                clearTimeout(t);
                console.warn(`[Proxy] 失败: ${e.name}`);
            }
        }
        console.warn(`[Proxy] ✗ 所有代理均失败: ${description}`);
        return null;
    },

    /** 清洗HTML → 纯文本 */
    _htmlToText(html) {
        let text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
            .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
            .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#?\w+;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return text;
    },

    /**
     * 检测文本是否为中文内容（中文字符占比 > 15%）
     * 用于过滤英文/不相关搜索结果
     */
    _isChineseContent(text, minRatio) {
        minRatio = minRatio || 0.15; // 至少15%是中文字符
        if (!text || text.length < 5) return false;
        let chineseCount = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if ((code >= 0x4E00 && code <= 0x9FFF) || // CJK统一汉字
                (code >= 0x3400 && code <= 0x4DBF) || // CJK扩展A
                (code >= 0x20000 && code <= 0x2A6DF)) { // CJK扩展B
                chineseCount++;
            }
        }
        const ratio = chineseCount / text.length;
        return ratio >= minRatio;
    },

    /**
     * 计算文本的中文占比
     */
    _chineseRatio(text) {
        if (!text || text.length === 0) return 0;
        let chineseCount = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if ((code >= 0x4E00 && code <= 0x9FFF) ||
                (code >= 0x3400 && code <= 0x4DBF) ||
                (code >= 0x20000 && code <= 0x2A6DF)) {
                chineseCount++;
            }
        }
        return chineseCount / text.length;
    },

    /** 通用搜索结果解析器：从搜索页HTML中提取标题、摘要、URL */
    _parseSearchResults(html, engine) {
        const results = [];
        const text = this._htmlToText(html);
        if (!text || text.length < 20) return results;

        // 不同搜索引擎使用不同解析策略
        const parsers = {
            bing: () => {
                // Bing搜索结果：查找 li.b_algo 结构
                const algoRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
                let match;
                while ((match = algoRegex.exec(html)) !== null) {
                    const block = match[1];
                    const titleMatch = block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
                    const hrefMatch = block.match(/href="(https?:\/\/[^"]+)"/i);
                    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
                        || block.match(/class="b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
                    if (titleMatch && hrefMatch) {
                        const rawTitle = this._htmlToText(titleMatch[1]);
                        const rawSnippet = snippetMatch ? this._htmlToText(snippetMatch[1]) : '';
                        // 过滤明显非中文结果；但保留百科类URL（可能有混合内容）
                        const isChinese = this._isChineseContent(rawTitle, 0.2) || this._isChineseContent(rawSnippet, 0.1);
                        const isEncyclopedia = /baike|百科|wiki百科|encyclopedia/i.test(hrefMatch[1]);
                        if (isChinese || isEncyclopedia) {
                            results.push({
                                title: rawTitle.substring(0, 100),
                                url: hrefMatch[1],
                                snippet: rawSnippet.substring(0, 300),
                                engine: 'Bing'
                            });
                        }
                    }
                }
            },
            baidu: () => {
                // 百度搜索结果
                const resultRegex = /<div[^>]*class="[^"]*result[^"]*c-container[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
                let match;
                while ((match = resultRegex.exec(html)) !== null) {
                    const block = match[1];
                    const titleMatch = block.match(/<a[^>]*>[\s\S]*?<em>([\s\S]*?)<\/em>[\s\S]*?<\/a>/i)
                        || block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
                    const hrefMatch = block.match(/href\s*=\s*"([^"]+)"/i)
                        || block.match(/data-url\s*=\s*"([^"]+)"/i);
                    const snippetMatch = block.match(/class="c-abstract"[^>]*>([\s\S]*?)<\/span>/i)
                        || block.match(/class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
                    if (titleMatch) {
                        results.push({
                            title: this._htmlToText(titleMatch[1]).substring(0, 100),
                            url: hrefMatch ? hrefMatch[1] : '',
                            snippet: snippetMatch ? this._htmlToText(snippetMatch[1]).substring(0, 300) : '',
                            engine: '百度'
                        });
                    }
                }
            },
            sogou: () => {
                // 搜狗搜索结果
                const resultRegex = /<div[^>]*class="[^"]*rb[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
                let match;
                while ((match = resultRegex.exec(html)) !== null) {
                    const block = match[1];
                    const titleMatch = block.match(/<a[^>]*id="[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
                        || block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
                    const hrefMatch = block.match(/href="([^"]+)"/i);
                    const snippetMatch = block.match(/class="[^"]*space-txt[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
                        || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
                    if (titleMatch) {
                        results.push({
                            title: this._htmlToText(titleMatch[1]).substring(0, 100),
                            url: hrefMatch ? hrefMatch[1] : '',
                            snippet: snippetMatch ? this._htmlToText(snippetMatch[1]).substring(0, 300) : '',
                            engine: '搜狗'
                        });
                    }
                }
            },
            // 通用兜底解析：查找所有链接和周围的文字（只保留中文内容）
            universal: () => {
                const linkRegex = /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
                let match;
                let count = 0;
                const seenTitles = new Set();
                while ((match = linkRegex.exec(html)) !== null && count < 15) {
                    const href = match[1];
                    const linkText = this._htmlToText(match[2]);
                    // 严格过滤：必须包含中文、长度合适、排除无关链接
                    if (linkText.length > 4 && linkText.length < 100 &&
                        this._isChineseContent(linkText, 0.3) &&
                        !href.includes('google') &&
                        !href.includes('javascript:') &&
                        !href.includes('mailto:') &&
                        !href.includes('microsoft') &&
                        !seenTitles.has(linkText.substring(0, 20))) {
                        seenTitles.add(linkText.substring(0, 20));
                        const afterLink = html.substring(match.index + match[0].length, match.index + match[0].length + 800);
                        const snippetMatch = afterLink.match(/>([^<]{20,200})</);
                        const snippet = snippetMatch ? snippetMatch[1].trim() : '';
                        results.push({
                            title: linkText.substring(0, 100),
                            url: href,
                            snippet: this._isChineseContent(snippet, 0.1) ? snippet : '',
                            engine: '通用'
                        });
                        count++;
                    }
                }
            }
        };

        // 先用专用解析器
        if (parsers[engine]) {
            parsers[engine]();
        }
        // 没结果时用通用解析
        if (results.length === 0) {
            parsers.universal();
        }

        console.log(`[解析] ${engine} → 提取到 ${results.length} 条结果`);
        return results.filter(r => r.title.length > 0).slice(0, 10);
    },

    /** 深度网页内容提取：从页面HTML中提取正文 */
    _extractMainContent(html) {
        // 移除干扰元素
        let cleaned = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[\s\S]*?<\/nav>/gi, '')
            .replace(/<footer[\s\S]*?<\/footer>/gi, '')
            .replace(/<header[\s\S]*?<\/header>/gi, '')
            .replace(/<aside[\s\S]*?<\/aside>/gi, '')
            .replace(/<form[\s\S]*?<\/form>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '');

        // 多种策略找正文区域
        const strategies = [
            // 策略1: article/main 标签
            () => {
                const m = cleaned.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
                return m ? m[1] : null;
            },
            // 策略2: 百度百科正文
            () => {
                const m = cleaned.match(/class="[^"]*para[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
                return m ? cleaned.substring(m.index, m.index + 2000) : null;
            },
            // 策略3: 最大文本块div
            () => {
                const divs = cleaned.match(/<div[^>]*>([\s\S]*?)<\/div>/gi);
                if (!divs) return null;
                let best = null, bestLen = 0;
                for (const div of divs) {
                    const txt = this._htmlToText(div);
                    if (txt.length > bestLen && txt.length < 5000) {
                        bestLen = txt.length;
                        best = div;
                    }
                }
                return bestLen > 100 ? best : null;
            },
            // 策略4: 所有p标签
            () => {
                const paras = cleaned.match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi);
                if (paras && paras.length > 3) {
                    return paras.slice(0, 20).join('\n');
                }
                return null;
            }
        ];

        for (const strategy of strategies) {
            const content = strategy();
            if (content) {
                const text = this._htmlToText(content);
                if (text.length > 30) {
                    console.log(`[深度提取] 获取正文 ${text.length} 字符`);
                    return text;
                }
            }
        }

        // 兜底：全页文本取中间
        const fullText = this._htmlToText(cleaned);
        if (fullText.length > 100) {
            const mid = Math.floor(fullText.length / 2);
            return fullText.substring(Math.max(0, mid - 800), Math.min(fullText.length, mid + 800));
        }
        return fullText.substring(0, 1500);
    },

    /** 搜索单个搜索引擎 */
    async _searchOneEngine(query, engine) {
        const searchUrls = {
            bing: `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-Hans&cc=cn&mkt=zh-CN`,
            baidu: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&ie=utf-8&rn=10`,
            sogou: `https://www.sogou.com/web?query=${encodeURIComponent(query)}`
        };
        const url = searchUrls[engine];
        if (!url) return [];

        const html = await this._fetchViaProxy(url, `${engine}搜索`);
        if (!html) return [];
        return this._parseSearchResults(html, engine);
    },

    /** 全网聚合搜索：并行搜索所有引擎，合并排序 */
    async _aggregateSearch(query) {
        console.log('[全网搜索] 并行检索 Bing + 百度 + 搜狗...');
        const startTime = Date.now();

        const [bingRes, baiduRes, sogouRes] = await Promise.allSettled([
            this._searchOneEngine(query, 'bing'),
            this._searchOneEngine(query, 'baidu'),
            this._searchOneEngine(query, 'sogou')
        ]);

        // 收集所有结果
        const allResults = [];
        const addResults = (res, engine) => {
            if (res.status === 'fulfilled' && Array.isArray(res.value)) {
                allResults.push(...res.value);
            }
        };
        addResults(bingRes, 'Bing');
        addResults(baiduRes, '百度');
        addResults(sogouRes, '搜狗');

        // 去重（基于URL相似度）
        const uniqueResults = [];
        const seenUrls = new Set();
        for (const r of allResults) {
            const key = r.url.replace(/^https?:\/\//, '').replace(/\/$/, '').substring(0, 60);
            if (!seenUrls.has(key) && r.url.startsWith('http')) {
                seenUrls.add(key);
                uniqueResults.push(r);
            }
        }

        // 按中文内容优先 + 片段长度 + 关键词相关性 综合排序
        uniqueResults.sort((a, b) => {
            const aChineseScore = this._chineseRatio(a.snippet || '') * 100 + this._chineseRatio(a.title) * 50;
            const bChineseScore = this._chineseRatio(b.snippet || '') * 100 + this._chineseRatio(b.title) * 50;
            const aLenScore = (a.snippet && a.snippet.length > 20 ? a.snippet.length : 0);
            const bLenScore = (b.snippet && b.snippet.length > 20 ? b.snippet.length : 0);
            // 中文内容权重最高
            const aTotal = aChineseScore * 3 + aLenScore * 0.3 + (a.title.length > 5 ? 5 : 0);
            const bTotal = bChineseScore * 3 + bLenScore * 0.3 + (b.title.length > 5 ? 5 : 0);
            return bTotal - aTotal;
        });

        const elapsed = Date.now() - startTime;
        console.log(`[全网搜索] 完成！耗时 ${elapsed}ms，去重后 ${uniqueResults.length} 条`);

        return uniqueResults.slice(0, 15);
    },

    /** 从搜索结果中智能提取答案（中文优先） */
    _extractAnswerFromResults(results, question) {
        const searchQ = this.extractSearchQuery(question);
        const keywords = searchQ.split(/\s+/).filter(k => k.length > 0);

        // 垃圾关键词黑名单（CORS代理经常返回公司年报等无关内容）
        const garbageWords = ['微软', 'Microsoft', 'microsoft', '年报', 'Annual Report',
            'NASDAQ', 'SEC', 'Form 10-K', '财年', '董事会', 'Board of Directors',
            '股东', 'shareholder', 'Stock', 'NYSE', 'investor', '披露', 'disclosure',
            'LinkedIn', 'GitHub', '社招', '校招', '招聘'];

        const _isGarbageSnippet = (snippet) => {
            for (const gw of garbageWords) {
                if (snippet.indexOf(gw) !== -1) return true;
            }
            return false;
        };

        let bestSnippet = null;
        let bestScore = -999;

        for (const r of results) {
            if (!r.snippet || r.snippet.length < 10) continue;

            // 中文内容占比得分（0~100）
            const chineseRatio = this._chineseRatio(r.snippet);
            const titleChinese = this._chineseRatio(r.title);
            
            // 纯英文或无中文 → 大幅降分，几乎不可能被选中
            if (chineseRatio < 0.05 && titleChinese < 0.1) continue;

            // 垃圾内容检测（CORS代理返回的公司年报等）
            if (_isGarbageSnippet(r.snippet) || _isGarbageSnippet(r.title)) {
                console.log('[垃圾过滤] 跳过垃圾结果:', r.title.substring(0, 40));
                continue;
            }

            let score = 0;
            // 中文占比越高，得分越高（这是最重要的维度）
            score += chineseRatio * 120;       // 满分 ~120
            score += titleChinese * 50;        // 标题中文加分

            // 关键词匹配得分
            for (const kw of keywords) {
                if (r.snippet.includes(kw)) score += kw.length * 3;
                if (r.title.includes(kw)) score += kw.length * 2;
            }

            // 百科类URL加分
            if (/baike|wiki|encyclopedia|百科/i.test(r.url)) score += 40;
            // 政府/教育网站加分
            if (/\.gov\.cn|\.edu\.cn/i.test(r.url)) score += 25;
            // 中文网站加分
            if (/\.cn/i.test(r.url)) score += 10;

            if (score > bestScore) {
                bestScore = score;
                bestSnippet = r;
            }
        }

        if (bestSnippet && bestSnippet.snippet.length > 15) {
            console.log(`[提取答案] 最佳片段 (score=${bestScore.toFixed(1)}, 中文=${(this._chineseRatio(bestSnippet.snippet)*100).toFixed(0)}%): ${bestSnippet.title} (${bestSnippet.engine})`);
            const cleaned = bestSnippet.snippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            return {
                answer: this.extractRelevantSnippet(cleaned, question, 300),
                source: `${bestSnippet.title} (${bestSnippet.engine})`,
                url: bestSnippet.url,
                platform: 'web_aggregate'
            };
        }
        return null;
    },

    /** 深度抓取：对top结果逐个抓取网页全文，提取答案（中文优先） */
    async _deepFetchAndExtract(results, question, maxCount) {
        maxCount = maxCount || 5;
        // 中文结果优先排在前面
        const sorted = [...results].sort((a, b) => {
            const aChinese = this._chineseRatio(a.title) + this._chineseRatio(a.snippet || '');
            const bChinese = this._chineseRatio(b.title) + this._chineseRatio(b.snippet || '');
            return bChinese - aChinese;
        });
        const candidates = sorted.slice(0, maxCount);

        for (const r of candidates) {
            if (!r.url || !r.url.startsWith('http')) continue;
            // 跳过明显的英文/无关网站
            const lowRelevance = [
                'youtube.com', 'facebook.com', 'twitter.com', 'instagram.com',
                'amazon.com', 'ebay.com', 'pinterest.com', 'reddit.com',
                'microsoft.com', 'linkedin.com', 'github.com', 'sec.gov',
                'bloomberg.com', 'reuters.com', 'wsj.com', 'ft.com'
            ];
            if (lowRelevance.some(d => r.url.includes(d))) {
                console.log(`[深度抓取] 跳过无关网站: ${r.title}`);
                continue;
            }

            console.log(`[深度抓取] 获取网页: ${r.title} (${r.url.substring(0, 60)}...)`);

            const html = await this._fetchViaProxy(r.url, `深度抓取: ${r.title.substring(0, 30)}`);
            if (!html) continue;

            const content = this._extractMainContent(html);
            if (!content || content.length < 30) continue;

            // 检查正文是否主要是中文
            if (!this._isChineseContent(content, 0.1)) {
                console.log(`[深度抓取] 跳过非中文内容: ${r.title} (中文占比=${(this._chineseRatio(content)*100).toFixed(0)}%)`);
                continue;
            }

            // 垃圾内容检测（微软年报等CORS代理返回的无关页面）
            const garbageCheck = ['微软', 'Microsoft', 'microsoft', '年报', 'Annual Report',
                'NASDAQ', 'SEC', 'Form 10-K', '财年', '董事会', '股东', 'shareholder',
                'LinkedIn', 'GitHub', '社招', '校招'];
            let isGarbageContent = false;
            for (const gw of garbageCheck) {
                if (content.indexOf(gw) !== -1) { isGarbageContent = true; break; }
            }
            if (isGarbageContent) {
                console.log(`[深度抓取] 检测到垃圾内容(公司年报等)，跳过: ${r.title}`);
                continue;
            }

            const answer = this.extractRelevantSnippet(content, question, 400);
            if (answer && answer.length > 15) {
                console.log(`[深度抓取] ✓ 提取到答案 (${answer.length} 字符)`);
                return {
                    answer: answer,
                    source: `${r.title} (${r.engine}网页提取)`,
                    url: r.url,
                    platform: 'deep_fetch'
                };
            }
        }
        console.warn('[深度抓取] 未提取到有效中文答案');
        return null;
    },

    /**
     * 生成多个搜索查询变体（从核心词→扩展词→百科词）
     * 例如: 输入"营造法式" → ["营造法式", "营造法式 建筑", "营造法式 百度百科"]
     */
    _generateSearchQueries(originalQ) {
        const searchQ = this.extractSearchQuery(originalQ);
        const queries = [searchQ]; // 基础查询
        
        // 从原始问题提取关键名词词组
        const clean = originalQ.replace(/[吗呢吧呀啊么？?！!。，,、\s]/g, '');
        
        // 如果问题较短（10字以内），直接作为查询
        if (clean.length <= 10 && clean !== searchQ) {
            queries.push(clean);
        }
        
        // 尝试加入建筑相关上下文词（如果原词不含这些）
        const contextWords = ['建筑', '中国古建筑', '百度百科', '维基百科', '百科'];
        const hasArchKeyword = /建筑|园林|寺庙|宫殿|桥梁|塔|长城|土楼/i.test(searchQ);
        
        for (const ctx of contextWords) {
            if (!searchQ.includes(ctx)) {
                const q = searchQ + ' ' + ctx;
                if (!queries.includes(q)) queries.push(q);
            }
        }
        
        // 如果原问题较长，尝试提取首尾关键部分
        if (originalQ.length > 12) {
            const parts = originalQ.split(/[，,。.！!？?\s、：:；;（）()]+/).filter(p => p.length >= 2);
            if (parts.length >= 2) {
                const shortQ = parts.slice(0, 2).join(' ');
                if (shortQ.length >= 4 && !queries.includes(shortQ)) {
                    queries.push(shortQ);
                }
            }
        }
        
        console.log('[查询生成] 原始问题:', originalQ.substring(0, 40));
        console.log('[查询生成] 变体列表:', queries.map(q => `"${q}"`).join(', '));
        return queries;
    },

    /**
     * 验证答案与问题是否相关
     * @returns {boolean} true=相关可用, false=不相关
     */
    _validateAnswerRelevance(answer, question) {
        if (!answer || answer.length < 10) return false;
        
        // 提取问题关键词
        const searchQ = this.extractSearchQuery(question);
        const keywords = searchQ.split(/\s+/).filter(k => k.length >= 2);
        // 补充bigram
        const rawClean = question.replace(/[，,.。!！?？\s、：:；;（）()「」『』""''【】《》—\-…·~～|\/\\]/g, '');
        for (let i = 0; i < rawClean.length - 1; i++) {
            const bg = rawClean.substring(i, i + 2);
            if (!keywords.includes(bg)) keywords.push(bg);
        }
        
        // 检查答案中是否包含任何关键词
        const answerLower = answer.toLowerCase();
        let matchCount = 0;
        for (const kw of keywords) {
            if (kw.length >= 2 && answerLower.includes(kw.toLowerCase())) {
                matchCount++;
            }
        }
        
        // 至少匹配2个关键词，或匹配1个长关键词（>=3字）
        const hasLongMatch = keywords.some(kw => kw.length >= 3 && answerLower.includes(kw.toLowerCase()));
        const isRelevant = matchCount >= 2 || hasLongMatch;
        
        if (!isRelevant) {
            console.warn('[相关性验证] 答案不相关 (匹配关键词:' + matchCount + '/' + keywords.length + ')');
        }
        return isRelevant;
    },

    /**
     * 主入口：百度百科搜索（快速直连）
     * 策略：直接URL抓取 → 搜索页解析 → 无结果则null
     * 不再使用 Wikipedia/DuckDuckGo/多引擎聚合，大幅提升速度
     */
        async findAnswer(question) {
        const normalizedQ = question.trim();
        if (normalizedQ.length < 2) {
            console.log('[WebSearch] 问题太短，跳过');
            return null;
        }

        // 检查缓存
        if (this.searchCache.has(normalizedQ)) {
            console.log('[WebSearch] 缓存命中:', normalizedQ);
            return this.searchCache.get(normalizedQ);
        }

        console.log('[WebSearch] ===== 开始百度百科搜索 =====');
        console.log('[WebSearch] 查询词:', normalizedQ);
        const startTime = Date.now();

        let result = null;

        // === 新策略：优先使用简化的直接抓取（更快更可靠）===
        console.log('[WebSearch] 策略0: 简化直接抓取...');
        const simpleResult = await this._simpleBaiduBaikeFetch(normalizedQ);
        if (simpleResult) {
            console.log(`[WebSearch] ✅ 简化抓取成功！耗时 ${Date.now()-startTime}ms`);
            result = simpleResult;
        }

        // === 策略1：原有的直接URL抓取 ===
        if (!result) {
            console.log('[WebSearch] 策略1: 传统直接URL抓取...');
            const directUrl = `https://baike.baidu.com/item/${encodeURIComponent(normalizedQ)}`;
            const directHtml = await this._fetchViaProxy(directUrl, '百度百科直接: ' + normalizedQ);
            
            if (directHtml) {
                const directContent = this._extractMainContent(directHtml);
                if (directContent && directContent.length > 30) {
                    const directAnswer = this.extractRelevantSnippet(directContent, normalizedQ, 500);
                    if (directAnswer && directAnswer.length > 15) {
                        result = {
                            answer: directAnswer,
                            source: normalizedQ + ' (百度百科)',
                            url: directUrl,
                            platform: 'baidu'
                        };
                        console.log(`[WebSearch] ✅ 传统直接抓取成功！耗时 ${Date.now()-startTime}ms`);
                    }
                }
            }
        }

        // === 策略1.5：调用本地 Flask 后端 (baike_server.py) ===
        if (!result) {
            console.log('[WebSearch] 策略1.5: 本地Flask后端搜索...');
            result = await this._flaskBackendSearch(normalizedQ);
        }

        // === 策略1.6：通过 Jina AI 搜索百度（非百科直链，更通用）===
        if (!result) {
            console.log('[WebSearch] 策略1.6: Jina AI 搜索百度...');
            result = await this._jinaAISearchBaidu(normalizedQ);
        }

        // === 策略2：搜索页解析 ===
        if (!result) {
            console.log('[WebSearch] 策略2: 搜索页解析...');
            result = await this._searchBaiduBaike(normalizedQ, normalizedQ);
        }

        if (result) {
            this.searchCache.set(normalizedQ, result);
            console.log('[WebSearch] 🎯 最终结果:', result.source);
            console.log('[WebSearch] 答案预览:', result.answer.substring(0, 80) + '...');
        } else {
            console.warn(`[WebSearch] ✗ 所有方法均失败，耗时 ${Date.now()-startTime}ms`);
        }

        return result;
    },

    /**
     * 百度百科智能搜索（重构版）
     * 
     * 核心流程：
     * ① 搜索 baike.baidu.com/search → 解析全部结果条目
     * ② 计算每条结果的标题与用户问题的相似度（编辑距离+关键词重叠）
     * ③ 选相似度最高的条目 → 代理抓取该百科页面全文
     * ④ 从页面正文中提取与问题最相关的段落作为答案
     * 
     * 兜底：搜索建议API → 直接链接
     */
    async _searchBaiduBaike(query, originalQ) {
        const baikeSearchUrl = `https://baike.baidu.com/search?word=${encodeURIComponent(query)}`;
        console.log('[百度百科] === 智能搜索启动 ===');

        // ===== 策略1：搜索页 → 解析结果列表 → 相似度排序 → 深度抓取 =====
        const searchHtml = await this._fetchViaProxy(baikeSearchUrl, '百度百科搜索');
        if (searchHtml) {
            // 1a. 解析所有搜索结果条目
            const searchResults = this._parseBaiduBaikeSearchResults(searchHtml);
            console.log(`[百度百科] 搜索页解析到 ${searchResults.length} 个候选条目`);

            if (searchResults.length > 0) {
                // 1b. 计算每条结果与问题的相似度，排序
                const scored = this._rankBaiduBaikeResults(searchResults, query, originalQ);
                console.log('[百度百科] 相似度排序前3:', scored.slice(0, 3).map(r => `${r.title} (${r.similarity.toFixed(3)})`));

                // 1c. 从高到低尝试抓取详情页
                for (const candidate of scored) {
                    if (candidate.similarity < 0.2) {
                        console.log(`[百度百科] 相似度过低 (${candidate.similarity.toFixed(3)})，跳过: ${candidate.title}`);
                        continue;
                    }

                    console.log(`[百度百科] 抓取相似度最高页面: ${candidate.title} (相似度=${candidate.similarity.toFixed(3)})`);
                    const detailHtml = await this._fetchViaProxy(candidate.url, `百科详情: ${candidate.title}`);
                    if (!detailHtml) continue;

                    // 1d. 提取正文内容
                    const content = this._extractMainContent(detailHtml);
                    if (!content || content.length < 20) {
                        console.warn(`[百度百科] ${candidate.title} 正文提取失败`);
                        continue;
                    }

                    // 1e. 从正文中提取与问题相关的片段
                    const answer = this.extractRelevantSnippet(content, originalQ, 400);
                    if (answer && answer.length > 15) {
                        console.log(`[百度百科] ✓ 成功！相似度=${candidate.similarity.toFixed(3)}，答案=${answer.length}字符`);
                        return {
                            answer: answer,
                            source: `${candidate.title} (百度百科)`,
                            url: candidate.url,
                            platform: 'baidu',
                            similarity: candidate.similarity
                        };
                    }
                }
                console.warn('[百度百科] 所有高相似度页面均抓取失败');
            } else {
                console.warn('[百度百科] 搜索页无有效结果条目');
            }
        }

        // ===== 策略1.5：直接构造百科 /item/ URL 抓取（比搜索页更可靠）=====
        console.log('[百度百科] 尝试直接URL抓取...');
        const directUrl = `https://baike.baidu.com/item/${encodeURIComponent(query)}`;
        const directHtml = await this._fetchViaProxy(directUrl, '百科直接: ' + query);
        if (directHtml) {
            const directContent = this._extractMainContent(directHtml);
            if (directContent && directContent.length > 50) {
                const directAnswer = this.extractRelevantSnippet(directContent, originalQ, 400);
                if (directAnswer && directAnswer.length > 20) {
                    const isChinese = this._isChineseContent(directAnswer, 0.1);
                    if (isChinese) {
                        console.log(`[百度百科] ✓ 直接URL抓取成功！答案=${directAnswer.length}字符`);
                        return {
                            answer: directAnswer,
                            source: `${query} (百度百科)`,
                            url: directUrl,
                            platform: 'baidu'
                        };
                    }
                }
            }
        }
        console.log('[百度百科] 直接URL抓取未成功');

        // ===== 策略2：百度搜索建议API（JSONP风格） =====
        try {
            console.log('[百度百科] 尝试搜索建议API...');
            const sugUrl = `https://www.baidu.com/sugrec?prod=pc&wd=${encodeURIComponent(query)}&cb=`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(sugUrl, { signal: controller.signal });
            clearTimeout(timeout);

            if (res.ok) {
                const text = await res.text();
                const jsonMatch = text.match(/\{.*\}/);
                if (jsonMatch) {
                    const data = JSON.parse(jsonMatch[0]);
                    if (data.g && data.g.length > 0) {
                        console.log('[百度百科] 搜索建议:', data.g.map(g => g.q));
                        return {
                            answer: `关于"${query}"，请点击下方链接查看百度百科的详细解释。`,
                            source: '百度百科',
                            url: baikeSearchUrl,
                            platform: 'baidu_link'
                        };
                    }
                }
            }
        } catch (e) {
            console.warn('[百度百科] 搜索建议API失败:', e.message);
        }

        // ===== 策略3：直接链接兜底 =====
        return {
            answer: `关于"${query}"，我已搜索了多个来源。你可以<a href="${baikeSearchUrl}" target="_blank" style="color:#92400e;font-weight:bold;">点击这里</a>在百度百科查看详细内容。`,
            source: '百度百科（点击查看）',
            url: baikeSearchUrl,
            platform: 'baidu_link'
        };
    },

    /**
     * 解析百度百科搜索结果页，提取所有候选条目
     * 返回 [{title, url, snippet}, ...]
     */
    _parseBaiduBaikeSearchResults(html) {
        const results = [];

        // 多种解析策略，提高兼容性
        const strategies = [
            // 策略A: 新版百度百科搜索结果 dl.search-list 结构
            () => {
                const dlRegex = /<dl[^>]*class="[^"]*search-list[^"]*"[^>]*>([\s\S]*?)<\/dl>/gi;
                let dlMatch;
                while ((dlMatch = dlRegex.exec(html)) !== null) {
                    const block = dlMatch[1];
                    const entry = this._parseBaiduBaikeEntry(block);
                    if (entry) results.push(entry);
                }
            },
            // 策略B: dt/dd 结构
            () => {
                const dtRegex = /<dt[^>]*>([\s\S]*?)<\/dt>/gi;
                const ddRegex = /<dd[^>]*>([\s\S]*?)<\/dd>/gi;
                let dtMatch, ddMatch;
                const titles = [], snippets = [];
                while ((dtMatch = dtRegex.exec(html)) !== null) {
                    const linkMatch = dtMatch[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
                    if (linkMatch) {
                        titles.push({ title: this._htmlToText(linkMatch[2]), url: linkMatch[1] });
                    }
                }
                while ((ddMatch = ddRegex.exec(html)) !== null) {
                    snippets.push(this._htmlToText(ddMatch[1]).substring(0, 200));
                }
                for (let i = 0; i < titles.length; i++) {
                    results.push({
                        title: titles[i].title,
                        url: titles[i].url,
                        snippet: snippets[i] || ''
                    });
                }
            },
            // 策略C: 查找所有 baike.baidu.com/item 链接
            () => {
                const linkRegex = /<a[^>]*href="(\/item\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
                let linkMatch;
                const seen = new Set();
                while ((linkMatch = linkRegex.exec(html)) !== null) {
                    const path = linkMatch[1];
                    const title = this._htmlToText(linkMatch[2]).trim();
                    if (title.length > 1 && !seen.has(path)) {
                        seen.add(path);
                        results.push({
                            title: title.substring(0, 80),
                            url: `https://baike.baidu.com${path}`,
                            snippet: ''
                        });
                    }
                }
            },
            // 策略D: 查找所有完整 baike.baidu.com 链接（含子域名）
            () => {
                const fullLinkRegex = /<a[^>]*href="(https?:\/\/baike\.baidu\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
                let fm;
                const seen = new Set();
                while ((fm = fullLinkRegex.exec(html)) !== null) {
                    const url = fm[1];
                    const title = this._htmlToText(fm[2]).trim();
                    const key = url.replace(/[?#].*$/, '');
                    if (title.length > 1 && !seen.has(key) && !url.includes('/search')) {
                        seen.add(key);
                        results.push({
                            title: title.substring(0, 80),
                            url: url,
                            snippet: ''
                        });
                    }
                }
            }
        ];

        for (const strategy of strategies) {
            strategy();
            if (results.length >= 3) break; // 够3条就停止
        }

        // 去重
        const unique = [];
        const seenUrls = new Set();
        for (const r of results) {
            const key = r.url.replace(/[?#].*$/, '').toLowerCase();
            if (!seenUrls.has(key) && r.title && r.url) {
                seenUrls.add(key);
                unique.push(r);
            }
        }
        return unique.filter(r => r.title.length > 0).slice(0, 10);
    },

    /** 解析单个百度百科条目（dl/dt/dd结构） */
    _parseBaiduBaikeEntry(block) {
        // 找链接
        const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) return null;
        const url = linkMatch[1].startsWith('http') ? linkMatch[1] : `https://baike.baidu.com${linkMatch[1]}`;
        const title = this._htmlToText(linkMatch[2]).trim();

        // 找描述文字
        let snippet = '';
        const textMatches = [
            block.match(/<p[^>]*>([\s\S]*?)<\/p>/i),
            block.match(/class="[^"]*(?:abstract|summary|desc|intro)[^"]*"[^>]*>([\s\S]*?)<\//i),
            block.match(/>([^<]{20,200})</)
        ];
        for (const m of textMatches) {
            if (m && m[1]) {
                snippet = this._htmlToText(m[1]).substring(0, 200);
                break;
            }
        }

        if (title.length < 2) return null;
        return { title: title.substring(0, 80), url, snippet };
    },

    /**
     * 对百度百科搜索结果按相似度排序
     * 综合多种维度：编辑距离、关键词重叠、Jaccard、长度相似
     */
    _rankBaiduBaikeResults(results, searchQuery, originalQ) {
        const keywords = searchQuery.split(/\s+/).filter(k => k.length > 0);

        const scored = results.map(r => {
            const entryTitle = r.title.toLowerCase();
            const queryLower = originalQ.toLowerCase();

            // 维度1: 编辑距离相似度
            const maxLen = Math.max(entryTitle.length, queryLower.length);
            const editSim = maxLen > 0 ? 1 - (this._levenshtein(entryTitle, queryLower) / maxLen) : 0;

            // 维度2: 关键词匹配得分
            let kwScore = 0;
            for (const kw of keywords) {
                if (entryTitle.includes(kw.toLowerCase())) {
                    kwScore += kw.length * 2;
                    if (entryTitle.startsWith(kw.toLowerCase())) kwScore += kw.length; // 开头匹配加分
                }
            }
            const kwSim = keywords.length > 0 ? Math.min(1, kwScore / (keywords.join('').length * 2)) : 0;

            // 维度3: bigram Jaccard 相似度
            const bigramsA = new Set();
            const bigramsB = new Set();
            const getBigrams = (str, set) => {
                const clean = str.replace(/[^ a-zA-Z\u4e00-\u9fa5]/g, '');
                for (let i = 0; i < clean.length - 1; i++) set.add(clean.substring(i, i + 2));
            };
            getBigrams(entryTitle, bigramsA);
            getBigrams(queryLower, bigramsB);
            let intersection = 0;
            bigramsA.forEach(b => { if (bigramsB.has(b)) intersection++; });
            const union = bigramsA.size + bigramsB.size - intersection;
            const jaccard = union > 0 ? intersection / union : 0;

            // 维度4: 长度相似度
            const lenDiff = Math.abs(entryTitle.length - queryLower.length);
            const lenSim = Math.max(0, 1 - lenDiff / Math.max(entryTitle.length, queryLower.length));

            // 维度5: snippet（摘要）中包含关键词的加分
            let snippetBonus = 0;
            if (r.snippet) {
                for (const kw of keywords) {
                    if (r.snippet.toLowerCase().includes(kw.toLowerCase())) snippetBonus += 3;
                }
            }

            // 综合得分
            const similarity = editSim * 0.30 + kwSim * 0.30 + jaccard * 0.20 + lenSim * 0.10 + snippetBonus * 0.02;

            return { ...r, similarity };
        });

        // 按相似度降序排列
        scored.sort((a, b) => b.similarity - a.similarity);
        return scored;
    },

    /** 编辑距离（莱文斯坦距离） */
    _levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const dp = [];
        for (let i = 0; i <= m; i++) { dp[i] = [i]; }
        for (let j = 0; j <= n; j++) { dp[0][j] = j; }
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = a[i - 1] === b[j - 1]
                    ? dp[i - 1][j - 1]
                    : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
        return dp[m][n];
    },

    /**
     * DuckDuckGo HTML 搜索（通过代理抓取 html.duckduckgo.com）
     * DDG 的 HTML 版本反爬较弱，比 Bing/百度更容易通过代理获取
     */
    async _searchDuckDuckGoHTML(query, originalQ) {
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' 建筑')}&kl=cn-zh`;
        console.log('[DDG HTML] 搜索:', query);
        
        const html = await this._fetchViaProxy(ddgUrl, 'DDG HTML搜索');
        if (!html) return null;
        
        // 解析 DDG HTML 结果
        const results = [];
        // DDG HTML 结果在 <a class="result__a"> 和 <a class="result__snippet">
        const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        
        let linkMatch;
        const links = [];
        while ((linkMatch = linkRegex.exec(html)) !== null) {
            const url = linkMatch[1];
            const title = this._htmlToText(linkMatch[2]).trim();
            // 过滤：需要URL和标题都合理
            if (url && url.startsWith('http') && title.length > 2 && 
                !url.includes('duckduckgo.com') && !url.includes('ad-')) {
                links.push({ url, title });
            }
        }
        
        let snippetMatch;
        const snippets = [];
        while ((snippetMatch = snippetRegex.exec(html)) !== null) {
            snippets.push(this._htmlToText(snippetMatch[1]).trim());
        }
        
        // 配对标题和摘要
        for (let i = 0; i < Math.min(links.length, snippets.length); i++) {
            results.push({
                title: links[i].title,
                url: links[i].url,
                snippet: snippets[i],
                engine: 'DDG'
            });
        }
        
        console.log(`[DDG HTML] 解析到 ${results.length} 条结果`);
        
        if (results.length === 0) return null;
        
        // 从结果中提取答案
        const extracted = this._extractAnswerFromResults(results, originalQ);
        if (extracted && extracted.answer.length > 15) {
            return extracted;
        }
        
        // 深度抓取top结果
        return await this._deepFetchAndExtract(results, originalQ, 2);
    },

    /**
     * DuckDuckGo Instant Answer API（只保留中文结果）
     */
    async _searchDuckDuckGo(query) {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&kl=cn-zh`;
        console.log('[DuckDuckGo] 请求...');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) return null;
            const data = await res.json();
            let answer = data.AbstractText || data.Answer || '';
            // 过滤非中文结果
            if (answer && answer.length > 10 && this._isChineseContent(answer, 0.1)) {
                return {
                    answer: this.extractRelevantSnippet(answer, query),
                    source: (data.Heading || 'DuckDuckGo'),
                    url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
                    platform: 'duckduckgo'
                };
            }
            if (answer && answer.length > 10) {
                console.log('[DuckDuckGo] 结果非中文，丢弃');
            }
            return null;
        } catch (e) {
            clearTimeout(timeout);
            console.warn('[DuckDuckGo] 错误:', e.name);
            return null;
        }
    },

    /**
     * 简化的百度百科直接抓取（使用Jina AI/Microlink等快API）
     */
    async _simpleBaiduBaikeFetch(query) {
        console.log('[简化抓取] 尝试快速方案获取:', query);
        
        // 方案1: Jina AI 网页内容提取（将整个页面转为纯文本）
        try {
            var jinaUrl = 'https://r.jina.ai/https://baike.baidu.com/item/' + encodeURIComponent(query);
            console.log('[简化抓取] Jina AI提取...');
            var ctrl = new AbortController();
            var t = setTimeout(function() { ctrl.abort(); }, 5000);
            var res = await fetch(jinaUrl, { signal: ctrl.signal });
            clearTimeout(t);
            if (res.ok) {
                var text = await res.text();
                if (text.length > 80 && this._isChineseContent(text, 0.05)) {
                    var answer = text.substring(0, 600).trim();
                    return {
                        answer: answer + (text.length > 600 ? '...' : ''),
                        source: query + ' (百度百科)',
                        url: 'https://baike.baidu.com/item/' + encodeURIComponent(query),
                        platform: 'baidu'
                    };
                }
            }
        } catch (e) { console.warn('[简化抓取] Jina失败:', e.message); }
        
        // 方案2: Microlink API
        try {
            var microUrl = 'https://api.microlink.io/?url=https://baike.baidu.com/item/' + encodeURIComponent(query);
            var ctrl2 = new AbortController();
            var t2 = setTimeout(function() { ctrl2.abort(); }, 5000);
            var res2 = await fetch(microUrl, { signal: ctrl2.signal });
            clearTimeout(t2);
            if (res2.ok) {
                var data = await res2.json();
                if (data.data && data.data.content && data.data.content.length > 50) {
                    return {
                        answer: data.data.content.substring(0, 600),
                        source: query + ' (百度百科)',
                        url: 'https://baike.baidu.com/item/' + encodeURIComponent(query),
                        platform: 'baidu'
                    };
                }
            }
        } catch (e) { console.warn('[简化抓取] Microlink失败:', e.message); }
        
        return null;
    },

    /**
     * 调用本地 Flask 后端搜索（baike_server.py）
     * 优势：服务端请求无CORS问题，支持维基百科+必应双数据源
     */
    async _flaskBackendSearch(query) {
        try {
            var ctrl = new AbortController();
            var t = setTimeout(function() { ctrl.abort(); }, 8000);
            var res = await fetch('http://localhost:5000/api/search?q=' + encodeURIComponent(query), { signal: ctrl.signal });
            clearTimeout(t);
            if (res.ok) {
                var data = await res.json();
                if (data.success && data.content && data.content.length > 30) {
                    console.log('[Flask后端] ✅ 搜索成功! 来源:', data.source, '长度:', data.content.length);
                    return {
                        answer: data.content.substring(0, 600),
                        source: (data.title || query) + ' (' + (data.source || '网络') + ')',
                        url: data.url || 'https://baike.baidu.com/item/' + encodeURIComponent(query),
                        platform: 'flask'
                    };
                }
            }
        } catch (e) {
            console.warn('[Flask后端] 搜索失败（baike_server.py 可能未启动）:', e.message);
        }
        return null;
    },

    /**
     * 通过 Jina AI 搜索百度（www.baidu.com），提取搜索结果摘要
     * 比直接抓百科页面更可靠：百度搜索结果页总能返回
     */
    async _jinaAISearchBaidu(query) {
        console.log('[Jina百度] 通过 Jina AI 搜索百度...');
        try {
            // 搜索 baidu.com，附加"百度百科"让结果更精准
            var jinaUrl = 'https://r.jina.ai/https://www.baidu.com/s?wd=' + encodeURIComponent(query + ' 百度百科');
            var ctrl = new AbortController();
            var t = setTimeout(function() { ctrl.abort(); }, 6000);
            var res = await fetch(jinaUrl, { signal: ctrl.signal });
            clearTimeout(t);
            if (res.ok) {
                var text = await res.text();
                if (text.length > 50 && this._isChineseContent(text, 0.03)) {
                    // Jina AI 返回纯文本 Markdown，提取相关片段
                    var answer = this.extractRelevantSnippet(text, query, 500);
                    if (answer && answer.length > 20) {
                        console.log('[Jina百度] ✅ 成功提取片段，长度:', answer.length);
                        return {
                            answer: answer,
                            source: query + ' (百度搜索)',
                            url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(query),
                            platform: 'baidu_search'
                        };
                    }
                }
            }
        } catch (e) {
            console.warn('[Jina百度] 失败:', e.message);
        }
        return null;
    },

    /**
     * 快速搜索百度百科词条链接（纯客户端，不使用CORS代理）
     * 速度极快：直接构造URL + 百度搜索建议API
     * @param {string} query - 搜索关键词
     * @returns {Array} - 词条链接数组 [{title, url, snippet, similarity}]
     */
    async searchBaiduBaikeLinks(query) {
        console.log('[百度百科链接] 快速生成词条链接:', query);
        var links = [];
        var seen = new Set();
        seen.add(query);

        // 提取核心实体词（去掉"的""特点""介绍"等后缀）
        var coreEntity = query.replace(/[的之]?(特点|特色|建筑|介绍|历史|结构|功能|用途|图片|是什么|有哪些|作用|意义|价值|原因|来历|由来|起源|背景).*$/, '').trim();
        if (coreEntity.length < 2) coreEntity = query;
        var cleanCore = coreEntity.replace(/[，,。.！!？?\s、：:；;（）()「」『』""''【】《》—\-…~]/g, '').trim();

        // === 方案1: 直接构造词条链接（使用清洗后的核心词，去掉"的作用是什么"等后缀） ===
        // 注意：如果直接用原始query如"护城河的作用是什么"构造URL，百度百科会返回空页面
        // 必须用cleanCore（如"护城河"）才能命中真实词条
        var coreSim = cleanCore === query ? 1.0 : WebSearchEngine._calcTermSimilarity(cleanCore, query);
        links.push({
            title: cleanCore + ' - 百度百科（直接入口）',
            url: 'https://baike.baidu.com/item/' + encodeURIComponent(cleanCore),
            snippet: '点击查看百度百科<' + cleanCore + '>完整词条',
            similarity: coreSim
        });

        // === 方案2: 百度搜索建议API（无CORS限制，速度快） ===
        try {
            var sugUrl = 'https://www.baidu.com/sugrec?prod=pc&wd=' + encodeURIComponent(query);
            var ctrl = new AbortController();
            var t = setTimeout(function() { ctrl.abort(); }, 2500);
            var res = await fetch(sugUrl, { signal: ctrl.signal });
            clearTimeout(t);

            if (res.ok) {
                var text = await res.text();
                var match = text.match(/\{.*\}/);
                if (match) {
                    var data = JSON.parse(match[0]);
                    if (data.g && data.g.length > 0) {
                        for (var i = 0; i < data.g.length && links.length < 12; i++) {
                            var term = (data.g[i].q || '').trim();
                            if (term && term.length >= 2 && !seen.has(term)) {
                                seen.add(term);
                                // 对建议词条计算相似度
                                var sim = WebSearchEngine._calcTermSimilarity(term, cleanCore);
                                links.push({
                                    title: '🔗 ' + term + ' - 百度百科',
                                    url: 'https://baike.baidu.com/item/' + encodeURIComponent(term),
                                    snippet: '与"' + query + '"相关的百度百科词条',
                                    similarity: sim
                                });
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[百度百科链接] 建议API失败:', e.message);
        }

        // === 方案3: 百度网页搜索链接（如果百科无结果，网页搜索总有） ===
        var baiduWebSearchUrl = 'https://www.baidu.com/s?wd=' + encodeURIComponent(query);
        if (!seen.has('baidu_web')) {
            seen.add('baidu_web');
            links.push({
                title: '🔍 在百度网页中搜索 "' + query + '"',
                url: baiduWebSearchUrl,
                snippet: '百度网页搜索结果（含百科、知道、文库等）',
                similarity: 0.75
            });
        }

        // === 方案4: 百度百科搜索页链接（兜底） ===
        var baikeSearchUrl = 'https://baike.baidu.com/search?word=' + encodeURIComponent(query);
        links.push({
            title: '📋 在百度百科中搜索 "' + query + '" 全部结果',
            url: baikeSearchUrl,
            snippet: '点击查看百度百科搜索全部结果列表',
            similarity: 0.6
        });

        return links;
    },

    /**
     * 快速计算两个词条的相似度（基于bigram和字符覆盖）
     */
    _calcTermSimilarity(term, query) {
        var t = term.toLowerCase().replace(/[🔗📋🔍·•\s-]/g, '');
        var q = query.toLowerCase().replace(/\s/g, '');
        if (t === q) return 1.0;
        if (t.indexOf(q) !== -1) return 0.9;
        if (q.indexOf(t) !== -1) return 0.85;

        var qBigrams = [];
        for (var i = 0; i < q.length - 1; i++) qBigrams.push(q.substring(i, i + 2));
        var matchCount = 0;
        for (var j = 0; j < qBigrams.length; j++) {
            if (t.indexOf(qBigrams[j]) !== -1) matchCount++;
        }
        var bigramRate = qBigrams.length > 0 ? matchCount / qBigrams.length : 0;

        var covered = 0;
        for (var k = 0; k < q.length; k++) {
            if (t.indexOf(q[k]) !== -1) covered++;
        }
        var charCov = q.length > 0 ? covered / q.length : 0;

        return Math.max(0.2, Math.min(0.95, bigramRate * 0.6 + charCov * 0.4));
    },

    /**
     * 为链接列表计算与查询词的真实相似度，并按匹配置信度排序
     * @param {Array} links - [{title, url, snippet, similarity}]
     * @param {string} query - 用户查询词
     * @returns {Array} - 重新排序并标记相似度的链接列表
     */
    _scoreLinksByQuery(links, query) {
        var cleanQ = query.replace(/[的了吗呢吧呀啊；。，,！？!?\\s\\-—·•]/g, '')
            .replace(/(特点|特色|建筑|介绍|历史|结构|功能|用途|图片|是什么|有哪些|作用|意义|价值|原因|来历|由来|起源|背景)$/g, '')
            .toLowerCase();
        var qBigrams = [];
        for (var i = 0; i < cleanQ.length - 1; i++) {
            qBigrams.push(cleanQ.substring(i, i + 2));
        }

        var scored = links.map(function(link) {
            var cleanT = link.title.replace(/[\\-\\s 百度百科直接入口🔗📋🔍·•,，。！!？?"]/g, '').replace(/^在百度\S{1,3}中搜索\s*"/, '').replace(/"$/,'').toLowerCase();
            var matchCount = 0;
            for (var j = 0; j < qBigrams.length; j++) {
                if (cleanT.indexOf(qBigrams[j]) !== -1) matchCount++;
            }
            var bigramRate = qBigrams.length > 0 ? matchCount / qBigrams.length : 0;

            // 字符级覆盖率
            var coveredChars = 0;
            for (var k = 0; k < cleanQ.length; k++) {
                if (cleanT.indexOf(cleanQ[k]) !== -1) coveredChars++;
            }
            var charCov = cleanQ.length > 0 ? coveredChars / cleanQ.length : 0;

            // 综合得分：bigram匹配率 60% + 字符覆盖率 40%
            var score = bigramRate * 0.6 + charCov * 0.4;
            return { title: link.title, url: link.url, snippet: link.snippet, similarity: score };
        });

        // 按相似度降序排列
        scored.sort(function(a, b) { return b.similarity - a.similarity; });

        // 百度网页搜索（AI答案）链接始终置顶，因为它最可靠
        var aiIdx = -1;
        for (var s = 0; s < scored.length; s++) {
            if (scored[s].url.indexOf('baidu.com/s?wd=') !== -1) {
                aiIdx = s;
                break;
            }
        }
        if (aiIdx > 0) {
            var aiLink = scored.splice(aiIdx, 1)[0];
            aiLink.similarity = Math.max(aiLink.similarity, 0.95);
            scored.unshift(aiLink);
        }

        return scored;
    },

    /**
     * 清除搜索缓存
     */
    clearCache: function() {
        this.searchCache.clear();
        console.log('[WebSearch] 缓存已清除');
    }
};

// 辅助：生成建议词条的简短描述
function resultSnippet(term, originalQuery) {
    if (term.indexOf(originalQuery) !== -1 && term !== originalQuery) {
        return '与"' + originalQuery + '"相关的百度百科词条';
    }
    return term + '的相关百度百科词条';
}

// 全局快速调用
async function webSearchAnswer(question) {
    return await WebSearchEngine.findAnswer(question);
}

/**
 * Chatbot 网络搜索 fallback（供各页面 chatSend 调用）
 * 当本地知识库匹配失败时，从网络搜索答案
 * 关键优化：5秒超时竞速 → 超时则直接展示百度百科词条链接
 * @param {string} question - 用户问题
 */
async function chatbotWebSearchFallback(question) {
    var content = document.getElementById('chatbotContent');

    // 显示搜索进度
    var progressMsg = document.createElement('div');
    progressMsg.style.cssText = 'margin-bottom:16px;display:flex;align-items:flex-start;gap:10px;';
    progressMsg.innerHTML = '<div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#92400e,#d97706);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fa-solid fa-search" style="color:white;font-size:14px;"></i></div><div style="background:#fef3c7;padding:12px 16px;border-radius:18px 18px 18px 4px;max-width:80%;font-size:13px;color:#92400e;">🔍 正在搜索百度百科...</div>';
    if (content) { content.appendChild(progressMsg); content.scrollTop = content.scrollHeight; }

    // ===== 5秒超时竞速：内容提取 vs 超时 =====
    var result = null;
    var timedOut = false;
    try {
        result = await Promise.race([
            webSearchAnswer(question),
            new Promise(function(_, reject) {
                setTimeout(function() {
                    timedOut = true;
                    reject(new Error('搜索超时(5s)'));
                }, 5000);
            })
        ]);
    } catch (e) {
        console.warn('[搜索] ' + (timedOut ? '5秒超时，跳过内容提取' : '搜索异常: ' + e.message));
    }

    // 移除搜索进度提示
    if (content && progressMsg.parentNode) {
        content.removeChild(progressMsg);
    }

    // ===== 有结果 → 验证并展示 =====
    if (!timedOut && result && result.answer && result.answer.length >= 10) {
        // 垃圾内容检测
        var garbagePatterns = [
            '微软', 'Microsoft', 'microsoft', '年报', 'annual report', 'Annual Report',
            'NASDAQ', 'nasdaq', '证券', 'SEC', 'Form 10-K', '10-K', '财年',
            'fiscal year', 'Fiscal Year', '董事会', 'Board of Directors', '股东',
            'shareholder', 'Shareholder', 'Stock', 'stock', 'NYSE', 'nyse',
            'investor', 'Investor', '披露', 'disclosure', '合规', 'compliance',
            '收入', 'revenue', 'Revenue', '利润表', '资产负债表', '现金流量',
            'LinkedIn', 'linkedin', 'GitHub', 'github', '社招', '校招', '招聘'
        ];
        var isGarbage = false;
        for (var gi = 0; gi < garbagePatterns.length; gi++) {
            if (result.answer.indexOf(garbagePatterns[gi]) !== -1) { isGarbage = true; break; }
        }
        if (isGarbage) {
            console.log('[搜索] 网页搜索内容被判定为垃圾，将尝试百度百科链接');
            result = null;
        }
        if (result && !WebSearchEngine._validateAnswerRelevance(result.answer, question)) {
            console.log('[搜索] 网页搜索内容与问题不相关，将尝试百度百科链接');
            result = null;
        }

        // 网页搜索结果无效 → 跳过展示逻辑，直接走百科链接兜底
        if (!result) {
            // do nothing here — fall through to line 1736+ baike link fallback
        } else {

        // ===== 并行获取百度百科词条链接（速度极快，不阻塞主流程） =====
        var baikeLinks = null;
        try {
            baikeLinks = await WebSearchEngine.searchBaiduBaikeLinks(question);
            if (baikeLinks && baikeLinks.length > 0) {
                baikeLinks = WebSearchEngine._scoreLinksByQuery(baikeLinks, question);
            }
        } catch (e) {
            console.warn('[链接搜索] 失败:', e);
        }

        // ===== 自动验证答案与问题的匹配率 =====
        var autoApproved = (typeof validateUserAnswer === 'function' && validateUserAnswer(question, result.answer));

        // 构建回答
        var answerHtml = result.answer;
        answerHtml += '<br><br><small style="color:#9ca3af;">📖 来源：<a href="' +
            result.url + '" target="_blank" style="color:#92400e;">' +
            escapeHtml(result.source) + '</a></small>';

        if (autoApproved) {
            if (typeof saveUserLearned === 'function') {
                saveUserLearned(question, result.answer);
            }
            if (typeof chatbot !== 'undefined' && typeof chatbot.learn === 'function') {
                chatbot.learn(question, result.answer);
            }
            answerHtml += '<br><br><small style="color:#059669;">✅ 我学会了！已存入云端数据库！😊</small>';
        } else {
            window.lastSearchResult = result.answer;
            window.lastSearchQuestion = question;
            answerHtml += '<br><br><small style="color:#92400e;font-weight:bold;">🤔 这个答案正确吗？</small><br>' +
                '<small style="color:#b45309;">✅ 如果正确，请回复 <b>"很好"</b> 或 <b>"正确"</b>，我会记住并存入云端！</small><br>' +
                '<small style="color:#dc2626;">❌ 如果不对，请回复 <b>"不对"</b>，或直接告诉我正确答案。</small>';
        }

        if (baikeLinks && baikeLinks.length > 0) {
            answerHtml += '<br>' + formatBaiduBaikeLinksHtml(baikeLinks, question);
        }

        addChatMessage(answerHtml, false);
        return;
        } // end else (valid result)

    }

    // ===== 无结果 / 超时 / 异常 → 尝试获取链接列表 =====
    var baikeLinks = null;
    try {
        baikeLinks = await WebSearchEngine.searchBaiduBaikeLinks(question);
    } catch (e) {
        console.warn('[链接搜索] 失败:', e);
    }

    if (baikeLinks && baikeLinks.length > 0) {
        // 用真实相似度重新标记链接
        baikeLinks = WebSearchEngine._scoreLinksByQuery(baikeLinks, question);
        var linkHtml = '<div>关于"<b>' + escapeHtml(question) + '</b>"，找到了以下匹配度较高的相关词条：</div>';
        linkHtml += formatBaiduBaikeLinksHtml(baikeLinks, question);
        addChatMessage(linkHtml, false);
        window.waitingForAnswer = question;
        return;
    }

    // 最终兜底：连链接都获取不到
    var reasonMsg = '没有找到关于"<b>' + escapeHtml(question) + '</b>"的答案。';
    reasonMsg += '<br><br>💡 <b>你能教我吗？</b>请直接输入正确答案，我会记住的！';

    addChatMessage(reasonMsg);
    window.waitingForAnswer = question;
}

/**
 * 搜索百度百科词条链接并展示给用户
 * 用户点击链接手动查找答案后，输入给机器人，存入云端
 */
async function showBaiduBaikeLinksAndWait(question, reasonMsg) {
    var msgHtml = reasonMsg + '<br><br>';

    try {
        // searchBaiduBaikeLinks 使用纯客户端方式（直接URL + 百度建议API），速度极快
        var links = await WebSearchEngine.searchBaiduBaikeLinks(question);
        if (links && links.length > 0) {
            msgHtml += formatBaiduBaikeLinksHtml(links, question);
        } else {
            msgHtml += '💡 <b>你能回答这个问题吗？</b>请直接输入正确答案，我会记住并存入云端数据库！';
        }
    } catch (e) {
        console.warn('[链接搜索] 失败:', e);
        msgHtml += '💡 <b>你能回答这个问题吗？</b>请直接输入正确答案，我会记住并存入云端数据库！';
    }

    addChatMessage(msgHtml);
    window.waitingForAnswer = question;
}

/**
 * 生成百度百科词条链接的HTML展示
 */
function formatBaiduBaikeLinksHtml(links, question) {
    if (!links || links.length === 0) return '';

    var html = '<div style="margin-top:8px;">';
    html += '<div style="font-weight:bold;color:#92400e;margin-bottom:8px;font-size:14px;">📚 百度百科相关词条链接（点击查看）：</div>';
    html += '<div style="background:#fef3c7;border-radius:10px;padding:8px 14px;max-height:280px;overflow-y:auto;">';

    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        var simPercent = link.similarity ? Math.round(link.similarity * 100) : 0;
        var simColor = simPercent >= 70 ? '#059669' : (simPercent >= 40 ? '#d97706' : '#9ca3af');
        var simText = ' <span style="color:' + simColor + ';font-size:10px;">(匹配度 ' + simPercent + '%)</span>';
        html += '<div style="padding:5px 0;' + (i < links.length - 1 ? 'border-bottom:1px solid #fde68a;' : '') + '">';
        html += '<a href="' + link.url + '" target="_blank" style="color:#b45309;font-weight:bold;text-decoration:none;font-size:13px;">';
        html += escapeHtml(link.title) + '</a>' + simText;
        if (link.snippet && link.snippet.length > 0) {
            html += '<div style="color:#6b7280;font-size:11px;margin-top:2px;">' + escapeHtml(link.snippet) + '</div>';
        }
        html += '</div>';
    }
    html += '</div>';
    html += '<div style="margin-top:10px;color:#92400e;font-size:12px;line-height:1.6;">';
    html += '💡 <b>请点击上方链接查看百度百科词条</b>，找到答案后直接输入给我，我会记住并存入云端数据库！';
    html += '</div>';
    html += '</div>';
    return html;
}

/**
 * 验证用户输入答案与问题是否相关
 * 核心指标：问题关键词在答案中的匹配次数 + 匹配覆盖长度
 * 不用字数硬限制，纯靠关键词匹配度判断
 * @param {string} question - 原始问题
 * @param {string} answer - 用户提供的答案
 * @returns {boolean} true=相关，可以存储；false=不相关，拒绝存储
 */
function validateUserAnswer(question, answer) {
    if (!question || !answer) return false;

    // 清理文本：去掉标点、语气词、问句词、换行等
    var cleanQ = question.replace(/[，,.。!！?？\s、：:；;（）()「」『』""''【】《》—\-…·~～|\/\\?吗呢吧呀啊么什么是有什么哪些怎样如何为什么是不是请问告诉我讲讲介绍说说给帮请能不能可以我想知道一下这个那个来说说明详细具体]/g, '').trim();
    var cleanA = answer.replace(/[，,.。!！?？\s、：:；;（）()「」『』""''【】《》—\-…·~～|\/\\\n\r\t]/g, '').trim();

    if (cleanQ.length < 2 || cleanA.length < 3) {
        console.warn('[用户答案验证] ✗ 文本太短: cleanQ=' + cleanQ.length + ', cleanA=' + cleanA.length);
        return false;
    }

    // === 最高优先级：答案直接包含完整的问题关键词 → 100%通过 ===
    if (cleanA.indexOf(cleanQ) !== -1) {
        console.log('[用户答案验证] ✓ 答案直接包含问题关键词: "' + cleanQ + '"');
        return true;
    }

    // === 第二步：检测答案中是否包含问题的核心内容词（4字及以上的连续片段）===
    // 这是最高效的判断：如果答案中有"标注性建筑"这种4字词组，铁定相关
    if (cleanQ.length >= 4) {
        for (var ci = 0; ci <= cleanQ.length - 4; ci++) {
            var chunk4 = cleanQ.substring(ci, ci + 4);
            // 跳过纯停用词组合（如"是什么""有没有"）
            if (/^[的是有在吗呢吧呀啊么什么怎如何哪请给帮别不要能可还就都会这那个]/g.test(chunk4)) continue;
            if (cleanA.indexOf(chunk4) !== -1) {
                console.log('[用户答案验证] ✓ 四字核心词匹配: "' + chunk4 + '"');
                return true;
            }
        }
    }

    // === 第一步：提取问题的 bigram（二字词片段）===
    var qBigrams = [];
    var seen = {};
    for (var i = 0; i < cleanQ.length - 1; i++) {
        var bg = cleanQ.substring(i, i + 2);
        if (!seen[bg] && !/^[\d\s\W_]+$/.test(bg)) {
            seen[bg] = true;
            qBigrams.push(bg);
        }
    }
    if (qBigrams.length === 0) return false;

    // === 第二步：统计匹配次数 + 匹配覆盖的字符数 ===
    var matchCount = 0;
    var coveredPositions = {};
    for (var j = 0; j < qBigrams.length; j++) {
        var bgw = qBigrams[j];
        if (cleanA.indexOf(bgw) !== -1) {
            matchCount++;
            var pos = cleanQ.indexOf(bgw);
            if (pos !== -1) {
                for (var p = pos; p < pos + bgw.length; p++) {
                    coveredPositions[p] = true;
                }
            }
        }
    }

    // 计算覆盖长度
    var coveredLen = 0;
    for (var key in coveredPositions) {
        if (coveredPositions.hasOwnProperty(key)) coveredLen++;
    }
    var coverage = cleanQ.length > 0 ? coveredLen / cleanQ.length : 0;
    var matchRate = matchCount / qBigrams.length;

    // === 综合关键字匹配度评分：优先判断 ===
    // 平衡 bigram 匹配率 和 字符覆盖率，综合>=65%即认为答案相关
    var combinedScore = matchRate * 0.5 + coverage * 0.5;
    if (combinedScore >= 0.3) {
        console.log('[用户答案验证] ✓ 综合匹配度通过: combinedScore=' + (combinedScore*100).toFixed(0) + '% (bigram匹配率=' + (matchRate*100).toFixed(0) + '%, 覆盖率=' + (coverage*100).toFixed(0) + '%)');
        return true;
    }

    // === 第三步：多级判断 ===

    // 强匹配：2个以上bigram匹配 + 覆盖问题40%以上字符 → 通过（降低阈值）
    if (matchCount >= 2 && coverage >= 0.4) {
        console.log('[用户答案验证] ✓ 强匹配通过: matchCount=' + matchCount + ', coverage=' + (coverage*100).toFixed(0) + '%');
        return true;
    }

    // 短问题高覆盖：1个bigram匹配但覆盖了60%以上的问题字符 → 通过
    if (matchCount >= 1 && coverage >= 0.6) {
        console.log('[用户答案验证] ✓ 短问高覆盖通过: matchCount=' + matchCount + ', coverage=' + (coverage*100).toFixed(0) + '%');
        return true;
    }

    // 次强匹配：3个以上bigram匹配但覆盖率略低 → 也通过
    if (matchCount >= 3 && coverage >= 0.3) {
        console.log('[用户答案验证] ✓ 多匹配通过: matchCount=' + matchCount + ', coverage=' + (coverage*100).toFixed(0) + '%');
        return true;
    }

    // 三字关键词额外检测：问题中 >=3 字的连续片段在答案中出现 → 通过
    if (cleanQ.length >= 3) {
        for (var k = 0; k <= cleanQ.length - 3; k++) {
            var tri = cleanQ.substring(k, k + 3);
            // 跳过纯停用词组合
            if (/^[的是有在吗呢吧呀啊么什怎如何哪请给帮别不要能可还就都会]/g.test(tri)) continue;
            if (cleanA.indexOf(tri) !== -1) {
                console.log('[用户答案验证] ✓ 三字词匹配通过: "' + tri + '"');
                return true;
            }
        }
    }

    console.warn('[用户答案验证] ✗ 不相关: matchCount=' + matchCount + '/' + qBigrams.length + ', coverage=' + (coverage*100).toFixed(0) + '%');
    return false;
}

/**
 * 获取用户答案与问题的匹配度评分（0-1）
 * 与 validateUserAnswer 使用相同算法，但返回分数而非布尔值
 * @param {string} question - 原始问题
 * @param {string} answer - 用户提供的答案
 * @returns {number} 0-1之间的匹配分数
 */
function getUserAnswerScore(question, answer) {
    if (!question || !answer) return 0;

    var cleanQ = question.replace(/[，,.。!！?？\s、：:；;（）()「」『』""''【】《》—\-…·~～|\/\\?吗呢吧呀啊么什么是有什么哪些怎样如何为什么是不是请问告诉我讲讲介绍说说给帮请能不能可以我想知道一下这个那个来说说明详细具体]/g, '').trim();
    var cleanA = answer.replace(/[，,.。!！?？\s、：:；;（）()「」『』""''【】《》—\-…·~～|\/\\\n\r\t]/g, '').trim();

    if (cleanQ.length < 2 || cleanA.length < 3) return 0;

    // 答案直接包含完整问题关键词 → 100%匹配
    if (cleanA.indexOf(cleanQ) !== -1) return 1.0;

    // 4字核心词匹配 → 高置信度
    if (cleanQ.length >= 4) {
        for (var ci = 0; ci <= cleanQ.length - 4; ci++) {
            var chunk4 = cleanQ.substring(ci, ci + 4);
            if (/^[的是有在吗呢吧呀啊么什么怎如何哪请给帮别不要能可还就都会这那个]/g.test(chunk4)) continue;
            if (cleanA.indexOf(chunk4) !== -1) return 1.0;
        }
    }

    // Bigram匹配
    var qBigrams = [];
    var seen = {};
    for (var i = 0; i < cleanQ.length - 1; i++) {
        var bg = cleanQ.substring(i, i + 2);
        if (!seen[bg] && !/^[\d\s\W_]+$/.test(bg)) {
            seen[bg] = true;
            qBigrams.push(bg);
        }
    }
    if (qBigrams.length === 0) return 0;

    var matchCount = 0;
    var coveredPositions = {};
    for (var j = 0; j < qBigrams.length; j++) {
        var bgw = qBigrams[j];
        if (cleanA.indexOf(bgw) !== -1) {
            matchCount++;
            var pos = cleanQ.indexOf(bgw);
            if (pos !== -1) {
                for (var p = pos; p < pos + bgw.length; p++) {
                    coveredPositions[p] = true;
                }
            }
        }
    }

    var coveredLen = 0;
    for (var key in coveredPositions) {
        if (coveredPositions.hasOwnProperty(key)) coveredLen++;
    }
    var coverage = cleanQ.length > 0 ? coveredLen / cleanQ.length : 0;
    var matchRate = matchCount / qBigrams.length;
    var combinedScore = matchRate * 0.5 + coverage * 0.5;

    // 三字关键词额外检测
    if (combinedScore < 0.5 && cleanQ.length >= 3) {
        for (var k = 0; k <= cleanQ.length - 3; k++) {
            var tri = cleanQ.substring(k, k + 3);
            if (/^[的是有在吗呢吧呀啊么什怎如何哪请给帮别不要能可还就都会]/g.test(tri)) continue;
            if (cleanA.indexOf(tri) !== -1) {
                combinedScore = Math.max(combinedScore, 0.55); // 三字匹配给出更高分
            }
        }
    }

    console.log('[答案评分] combinedScore=' + (combinedScore*100).toFixed(0) + '% (bigram匹配率=' + (matchRate*100).toFixed(0) + '%, 覆盖率=' + (coverage*100).toFixed(0) + '%)');
    return combinedScore;
}

/**
 * HTML转义，防止XSS
 */
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

