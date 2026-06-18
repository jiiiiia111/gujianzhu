/**
 * 智能聊天机器人 - 基于数据挖掘技术的问答系统
 * 
 * 功能：
 * 1. 文本相似度匹配（TF-IDF + 余弦相似度）
 * 2. 关键词提取和权重计算
 * 3. 动态学习和更新知识库
 * 4. 语义相似度分析
 */

class IntelligentChatbot {
    constructor() {
        this.knowledgeBase = [];
        this.vocabulary = new Set();
        this.idfCache = new Map();
        this.initialized = false;
        this.userLearned = new Map(); // 用户学习的知识：问题 -> 答案
    }

    /**
     * 加载用户学习的知识（从localStorage）
     */
    loadUserLearned() {
        try {
            const saved = localStorage.getItem('chatbot_user_learned');
            if (saved) {
                const data = JSON.parse(saved);
                this.userLearned = new Map(data);
                console.log(`已加载 ${this.userLearned.size} 条用户学习的知识`);
            }
        } catch (e) {
            console.error('加载用户知识失败:', e);
        }
    }

    /**
     * 保存用户学习的知识（到localStorage + Supabase云端）
     */
    saveUserLearned() {
        try {
            const data = Array.from(this.userLearned.entries());
            localStorage.setItem('chatbot_user_learned', JSON.stringify(data));
            console.log(`已保存 ${this.userLearned.size} 条用户学习的知识`);
        } catch (e) {
            console.error('保存用户知识失败:', e);
        }
    }

    /**
     * 同时保存到云端（异步，不阻塞）
     */
    async saveUserLearnedToCloud(question, answer) {
        if (typeof supabaseSaveQA === 'function') {
            await supabaseSaveQA(question, answer);
        }
    }

    /**
     * 检查用户是否已学习过这个问题
     * @param {string} query - 用户问题
     * @returns {string|null} - 用户学习的答案，如果没有则返回null
     */
    getUserLearnedAnswer(query) {
        const normalizedQuery = query.trim().toLowerCase();
        for (const [savedQuery, answer] of this.userLearned) {
            if (savedQuery.trim().toLowerCase() === normalizedQuery) {
                return answer;
            }
        }
        return null;
    }

    /**
     * 用户学习：记住某个问题的答案
     * @param {string} question - 问题
     * @param {string} answer - 答案
     */
    learn(question, answer) {
        this.userLearned.set(question.trim(), answer.trim());
        this.saveUserLearned();
        // 异步同步到云端
        if (typeof supabaseSaveQA === 'function') {
            supabaseSaveQA(question.trim(), answer.trim());
        }
        console.log(`已学习: "${question}" -> "${answer}"`);
    }

    /**
     * 用户纠正：更新某个问题的答案
     * @param {string} question - 问题
     * @param {string} newAnswer - 新的答案
     */
    correct(question, newAnswer) {
        this.userLearned.set(question.trim(), newAnswer.trim());
        this.saveUserLearned();

        // 异步同步到云端
        if (typeof supabaseSaveQA === 'function') {
            supabaseSaveQA(question.trim(), newAnswer.trim());
        }

        // 同时更新知识库中的答案
        for (const item of this.knowledgeBase) {
            if (this.stringSimilarity(question, item.question) > 0.6) {
                item.answer = newAnswer.trim();
                item.keywords = this.extractKeywords(question);
                console.log(`已更新知识库中的答案: "${item.question}"`);
            }
        }

        // 重新计算TF-IDF
        this.buildVocabulary();
        this.calculateIDF();
        this.calculateTFIDF();

        console.log(`已纠正: "${question}" -> "${newAnswer}"`);
    }

    /**
     * 初始化知识库
     * @param {Array} questions - 问题数组
     * @param {Array} answers - 对应答案数组
     * @param {Array} briefs - 精简答案数组（可选）
     */
    initialize(questions, answers, briefs = []) {
        this.knowledgeBase = questions.map((q, i) => ({
            question: q,
            answer: answers[i],
            brief: briefs[i] || null,  // 精简答案
            keywords: this.extractKeywords(q),
            tfVector: null
        }));

        // 构建词汇表
        this.buildVocabulary();
        
        // 计算IDF
        this.calculateIDF();

        // 计算TF-IDF向量
        this.calculateTFIDF();

        this.initialized = true;
        console.log(`知识库初始化完成，共 ${this.knowledgeBase.length} 条问答`);

        // 初始化后加载用户学习的知识
        this.loadUserLearned();
    }

    /**
     * 中文分词（简化版）
     * @param {string} text - 输入文本
     * @returns {Array} - 分词结果
     */
    tokenize(text) {
        // 简单的分词策略：按空格、标点符号分割，并处理连续的中文
        text = text.toLowerCase();
        
        // 移除标点符号
        text = text.replace(/[，。！？、；：""''（）\[\]\{\}.,!?;:()\[\]{}]/g, ' ');
        
        // 按空格分割
        const tokens = text.split(/\s+/).filter(t => t.trim().length > 0);
        
        // 对于中文，还需要进一步分割连续的字符
        const result = [];
        for (const token of tokens) {
            if (/^[\u4e00-\u9fa5]+$/.test(token)) {
                // 中文：单字或双字组合
                for (let i = 0; i < token.length; i++) {
                    result.push(token[i]);
                    if (i < token.length - 1) {
                        result.push(token.substring(i, i + 2));
                    }
                }
            } else {
                // 英文或数字
                result.push(token);
            }
        }
        
        return result;
    }

    /**
     * 提取关键词
     * @param {string} text - 输入文本
     * @returns {Array} - 关键词数组
     */
    extractKeywords(text) {
        const tokens = this.tokenize(text);
        
        // 词频统计
        const freq = new Map();
        tokens.forEach(token => {
            freq.set(token, (freq.get(token) || 0) + 1);
        });

        // 停用词过滤（简化版）
        const stopWords = new Set([
            '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
            '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有',
            '看', '好', '自己', '这', '那', '吗', '呢', '吧', '啊', '哦', '呀',
            'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
            'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those'
        ]);

        // 过滤停用词和低频词
        const keywords = [];
        const sorted = Array.from(freq.entries())
            .filter(([token]) => !stopWords.has(token))
            .filter(([, count]) => count >= 1)
            .sort((a, b) => b[1] - a[1]);

        // 取前N个关键词
        return sorted.slice(0, 10).map(([token]) => token);
    }

    /**
     * 构建词汇表
     */
    buildVocabulary() {
        this.vocabulary.clear();
        this.knowledgeBase.forEach(item => {
            this.tokenize(item.question).forEach(word => {
                this.vocabulary.add(word);
            });
        });
    }

    /**
     * 计算IDF（逆文档频率）
     */
    calculateIDF() {
        const N = this.knowledgeBase.length;
        
        this.vocabulary.forEach(word => {
            let docCount = 0;
            this.knowledgeBase.forEach(item => {
                if (this.tokenize(item.question).includes(word)) {
                    docCount++;
                }
            });
            
            // IDF = log(N / df)
            this.idfCache.set(word, Math.log(N / (docCount + 1)));
        });
    }

    /**
     * 计算TF（词频）
     * @param {string} text - 输入文本
     * @returns {Map} - 词频Map
     */
    calculateTF(text) {
        const tokens = this.tokenize(text);
        const tf = new Map();
        const total = tokens.length;

        tokens.forEach(token => {
            tf.set(token, (tf.get(token) || 0) + 1 / total);
        });

        return tf;
    }

    /**
     * 计算TF-IDF向量
     */
    calculateTFIDF() {
        this.knowledgeBase.forEach(item => {
            const tf = this.calculateTF(item.question);
            const vector = new Map();

            this.vocabulary.forEach(word => {
                const tfValue = tf.get(word) || 0;
                const idfValue = this.idfCache.get(word) || 0;
                vector.set(word, tfValue * idfValue);
            });

            item.tfVector = vector;
        });
    }

    /**
     * 计算余弦相似度
     * @param {Map} vecA - 向量A
     * @param {Map} vecB - 向量B
     * @returns {number} - 相似度 (0-1)
     */
    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        // 计算点积
        vecA.forEach((value, key) => {
            if (vecB.has(key)) {
                dotProduct += value * vecB.get(key);
            }
            normA += value * value;
        });

        // 计算范数
        vecB.forEach((value) => {
            normB += value * value;
        });

        if (normA === 0 || normB === 0) return 0;

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * 计算编辑距离（Levenshtein Distance）
     * @param {string} str1 - 字符串1
     * @param {string} str2 - 字符串2
     * @returns {number} - 编辑距离
     */
    levenshteinDistance(str1, str2) {
        const m = str1.length;
        const n = str2.length;
        const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (str1[i - 1] === str2[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1];
                } else {
                    dp[i][j] = Math.min(
                        dp[i - 1][j] + 1,    // 删除
                        dp[i][j - 1] + 1,    // 插入
                        dp[i - 1][j - 1] + 1 // 替换
                    );
                }
            }
        }

        return dp[m][n];
    }

    /**
     * 计算字符串相似度（基于编辑距离）
     * @param {string} str1 - 字符串1
     * @param {string} str2 - 字符串2
     * @returns {number} - 相似度 (0-1)
     */
    stringSimilarity(str1, str2) {
        const distance = this.levenshteinDistance(str1, str2);
        const maxLen = Math.max(str1.length, str2.length);
        if (maxLen === 0) return 1;
        return 1 - distance / maxLen;
    }

    /**
     * 检测问题是否要求详细回答
     * @param {string} query - 用户问题
     * @returns {boolean} - 是否需要详细
     */
    isAskingForDetail(query) {
        const detailPatterns = [
            '详细', '完整', '详细点', '详细说说', '详细介绍一下',
            '具体', '具体说说', '全部', '全部说', '展开', '展开说',
            '多说说', '多介绍一下', '多说一点', '详细介绍一下'
        ];
        return detailPatterns.some(pattern => query.includes(pattern));
    }

    /**
     * 智能提取答案中与问题最相关的子字符串
     * @param {string} query - 用户问题
     * @param {string} answer - 原始答案
     * @returns {string} - 智能提取的答案
     */
    extractRelevantSnippet(query, answer) {
        const queryKeywords = this.extractKeywords(query);
        
        // 将答案按段落和句子分割
        // 先按换行分割，再按句号分割
        const paragraphs = answer.split(/\n/);
        const allSegments = [];
        
        paragraphs.forEach((para, paraIdx) => {
            // 按逗号、分号、顿号分割成更小的片段
            const segments = para.split(/[,，；;、]/);
            segments.forEach((seg, segIdx) => {
                if (seg.trim()) {
                    allSegments.push({
                        text: seg.trim(),
                        paraIndex: paraIdx,
                        segmentIndex: segIdx,
                        fullText: para.trim()
                    });
                }
            });
        });
        
        // 计算每个片段与问题的相关度
        const scoredSegments = allSegments.map((segment, index) => {
            let score = 0;
            let matchCount = 0;
            
            for (const keyword of queryKeywords) {
                if (segment.text.includes(keyword)) {
                    matchCount++;
                    // 关键词越长，得分越高
                    score += keyword.length * 2;
                    // 关键词在片段开头，得分更高
                    if (segment.text.indexOf(keyword) < 5) {
                        score += keyword.length;
                    }
                }
            }
            
            // 如果有匹配，提高分数
            if (matchCount > 0) {
                score = score * (1 + matchCount * 0.3);
            }
            
            return { ...segment, score, index };
        });
        
        // 按相关度排序
        scoredSegments.sort((a, b) => b.score - a.score);
        
        // 选取得分最高的片段，优先选取包含最多关键词的
        const result = [];
        const maxLength = 120; // 最大长度
        
        for (const seg of scoredSegments) {
            if (seg.score > 0) {
                let selectedText = seg.text;
                
                // 如果片段太短，尝试包含同一段落的其他部分
                if (selectedText.length < 20 && seg.fullText.length <= maxLength) {
                    selectedText = seg.fullText;
                }
                
                // 检查总长度
                const currentLength = result.join('，').length;
                if (currentLength + selectedText.length <= maxLength) {
                    result.push(selectedText);
                }
                
                // 如果已经有足够的内容，停止
                if (result.join('，').length >= 80) break;
            }
        }
        
        if (result.length > 0) {
            return result.join('，') + '。';
        }
        
        // 如果没有找到匹配，返回答案开头
        return answer.substring(0, 60) + (answer.length > 60 ? '...' : '');
    }

    /**
     * 检测问题是否泛指（需要完整答案）
     * @param {string} query - 用户问题
     * @returns {boolean} - 是否泛指
     */
    isGeneralQuery(query) {
        const generalPatterns = [
            '介绍', '介绍一下', '说说什么是', '说说什么是',
            '是什么', '有哪些', '有什么', '包含哪些',
            '有哪些', '有什么特点', '有什么特色'
        ];
        return generalPatterns.some(pattern => query.includes(pattern));
    }

    /**
     * 检测用户是否在纠正（说答案不对）
     * @param {string} query - 用户输入
     * @returns {boolean} - 是否在纠正
     */
    isCorrecting(query) {
        const patterns = [
            '不对', '不是', '错了', '不正确', '错误',
            '错啦', '不对不对', '不是的', '不是吧',
            '不对吧', '有问题', '有问题吧', '不准'
        ];
        return patterns.some(p => query.includes(p));
    }

    /**
     * 提取上一次的对话（需要配合前端存储）
     */
    setLastQA(question, answer) {
        this._lastQuestion = question;
        this._lastAnswer = answer;
    }

    /**
     * 获取纠正模式下的提示
     * @returns {string} - 提示用户给出正确答案
     */
    getCorrectionPrompt() {
        return '抱歉我说错了！你能告诉我正确的答案是什么吗？';
    }

    /**
     * 计算答案匹配长度得分
     * 在答案中找与问题匹配最长的词条，并根据答案长度动态调整权重
     * @param {string} query - 用户问题
     * @param {string} answer - 答案文本
     * @returns {number} - 匹配得分 (0-1)
     */
    calculateAnswerMatchScore(query, answer) {
        const queryKeywords = this.extractKeywords(query);
        if (queryKeywords.length === 0) return 0;

        let maxMatchLength = 0;
        let totalMatchLength = 0;

        // 在答案中搜索每个关键词的最长匹配
        for (const keyword of queryKeywords) {
            // 使用滑动窗口找最长匹配
            let keywordMaxLen = 0;
            
            // 尝试不同长度的子串匹配
            for (let len = keyword.length; len >= 2; len--) {
                for (let i = 0; i <= keyword.length - len; i++) {
                    const subStr = keyword.substring(i, i + len);
                    if (answer.includes(subStr)) {
                        keywordMaxLen = Math.max(keywordMaxLen, len);
                        break; // 找到即可，不用找更长的
                    }
                }
                if (keywordMaxLen > 0) break;
            }
            
            maxMatchLength = Math.max(maxMatchLength, keywordMaxLen);
            totalMatchLength += keywordMaxLen;
        }

        // 归一化：最长匹配 / 问题关键词平均长度
        const avgKeywordLen = queryKeywords.reduce((sum, k) => sum + k.length, 0) / queryKeywords.length;
        const lengthScore = avgKeywordLen > 0 ? maxMatchLength / avgKeywordLen : 0;

        // 计算覆盖率：有多少关键词在答案中匹配到
        const coverageRate = queryKeywords.filter(k => 
            queryKeywords.some(qk => answer.includes(qk.substring(0, Math.min(2, qk.length))))
        ).length / queryKeywords.length;

        // 综合得分：长度得分 * 0.6 + 覆盖率 * 0.4
        return Math.min(1, lengthScore * 0.6 + coverageRate * 0.4);
    }

    /**
     * 计算答案长度调整因子
     * 答案越长，越依赖问题匹配；答案越短，答案匹配权重更高
     * @param {string} answer - 答案文本
     * @returns {number} - 调整因子 (0.5-1.5)
     */
    calculateLengthFactor(answer) {
        const answerLen = answer.length;
        // 短答案（<50字）：因子1.2，更依赖答案匹配
        // 中等答案（50-200字）：因子1.0
        // 长答案（>200字）：因子0.8，降低答案匹配的权重
        if (answerLen < 50) return 1.2;
        if (answerLen < 200) return 1.0;
        return Math.max(0.7, 1.0 - (answerLen - 200) / 1000);
    }

    /**
     * 查找最相似的问答
     * @param {string} query - 用户问题
     * @param {number} threshold - 相似度阈值
     * @returns {Object|null} - 最佳匹配的问答
     */
    findBestMatch(query, threshold = 0.3) {
        if (!this.initialized) {
            console.error('知识库未初始化');
            return null;
        }

        // 检测用户是否在纠正
        if (this.isCorrecting(query)) {
            if (this._lastQuestion && this._lastAnswer) {
                console.log(`用户纠正上一个问题: "${this._lastQuestion}"`);
                return {
                    isCorrection: true,
                    question: this._lastQuestion,
                    answer: this._lastAnswer,
                    prompt: '抱歉，请您告诉我正确的答案是什么？'
                };
            } else {
                return {
                    isCorrection: true,
                    prompt: '抱歉，我还没有回答过问题。您可以直接告诉我正确的答案和对应的问题吗？'
                };
            }
        }

        // 优先检查用户学习过的知识
        const userAnswer = this.getUserLearnedAnswer(query);
        if (userAnswer) {
            console.log(`使用用户学习的答案: "${query}"`);
            return {
                question: query,
                answer: userAnswer,
                isUserLearned: true
            };
        }

        let bestMatch = null;
        let bestScore = 0;

        // 计算查询的TF-IDF向量
        const queryTF = this.calculateTF(query);
        const queryVector = new Map();
        this.vocabulary.forEach(word => {
            const tfValue = queryTF.get(word) || 0;
            const idfValue = this.idfCache.get(word) || 0;
            queryVector.set(word, tfValue * idfValue);
        });

        // 遍历知识库，计算相似度
        this.knowledgeBase.forEach(item => {
            // TF-IDF相似度
            const tfidfScore = this.cosineSimilarity(queryVector, item.tfVector);

            // 字符串相似度（Levenshtein）
            const stringScore = this.stringSimilarity(query, item.question);

            // 关键词匹配度（传入原始问题）
            const queryKeywords = this.extractKeywords(query);
            const keywordScore = this.calculateKeywordScore(queryKeywords, item.keywords, query, item.question);

            // 问题长度相似度（新增）
            const lengthScore = this.calculateLengthSimilarity(query, item.question);

            // 关键词重叠度（新增）
            const overlapScore = this.calculateOverlapSimilarity(query, item.question);

            // 答案匹配长度得分（新增）
            const answerMatchScore = this.calculateAnswerMatchScore(query, item.answer);

            // 答案长度调整因子
            const lengthFactor = this.calculateLengthFactor(item.answer);

            // 综合评分（改进版）
            const adjustedAnswerScore = answerMatchScore * lengthFactor;

            // 问题匹配得分（综合多种相似度）
            const questionMatchScore =
                tfidfScore * 0.25 +
                stringScore * 0.15 +
                keywordScore * 0.20 +
                lengthScore * 0.20 +      // 长度相似度
                overlapScore * 0.20;       // 重叠度

            const totalScore =
                questionMatchScore * 0.70 +      // 问题匹配权重
                adjustedAnswerScore * 0.30;      // 答案匹配权重

            if (totalScore > bestScore) {
                bestScore = totalScore;
                bestMatch = item;
            }
        });

        // 检查是否超过阈值
        if (bestScore >= threshold) {
            // 保存这次的问答对，以便用户纠正时使用
            this.setLastQA(query, bestMatch.answer);

            // 如果是泛指问题（"介绍一下"、"是什么"），返回完整答案
            // 否则智能提取相关片段
            if (this.isGeneralQuery(query) || this.isAskingForDetail(query)) {
                // 返回完整答案
                bestMatch.isExtracted = false;
                console.log(`最佳匹配得分: ${bestScore.toFixed(3)}, 问题: ${bestMatch.question} [完整答案]`);
            } else {
                // 智能提取相关片段
                const originalAnswer = bestMatch.answer;
                bestMatch.answer = this.extractRelevantSnippet(query, originalAnswer);
                bestMatch.isExtracted = true;
                console.log(`最佳匹配得分: ${bestScore.toFixed(3)}, 问题: ${bestMatch.question} [智能提取]`);
            }
            return bestMatch;
        }

        console.log(`未找到匹配，最高得分: ${bestScore.toFixed(3)}`);
        return null;
    }

    /**
     * 计算关键词匹配分数
     * 优先匹配问题的核心关键词（末尾的词）
     * @param {Array} queryKeywords - 查询关键词
     * @param {Array} itemKeywords - 知识库关键词
     * @param {string} query - 原始问题
     * @param {string} itemQuestion - 知识库问题
     * @returns {number} - 匹配分数 (0-1)
     */
    calculateKeywordScore(queryKeywords, itemKeywords, query = '', itemQuestion = '') {
        if (queryKeywords.length === 0 || itemKeywords.length === 0) return 0;

        let matchCount = 0;
        let coreMatchCount = 0; // 核心关键词匹配

        // 提取问题的核心词（名词，通常在末尾）
        const queryCore = this.extractCoreKeywords(query);
        const itemCore = this.extractCoreKeywords(itemQuestion);

        queryKeywords.forEach(keyword => {
            if (itemKeywords.includes(keyword)) {
                matchCount++;
                // 如果这个关键词也是核心词，额外加分
                if (queryCore.includes(keyword) || itemCore.includes(keyword)) {
                    coreMatchCount += 2;
                }
            }
        });

        // 综合得分：普通匹配 + 核心词额外得分
        const baseScore = matchCount / queryKeywords.length;
        const coreBonus = coreMatchCount / (queryKeywords.length * 2);

        return Math.min(1, baseScore + coreBonus * 0.5);
    }

    /**
     * 计算问题长度相似度
     * @param {string} query - 用户问题
     * @param {string} itemQuestion - 知识库问题
     * @returns {number} - 相似度 (0-1)
     */
    calculateLengthSimilarity(query, itemQuestion) {
        // 按字符长度计算
        const len1 = query.length;
        const len2 = itemQuestion.length;

        // 长度越接近，得分越高
        const diff = Math.abs(len1 - len2);
        const maxLen = Math.max(len1, len2);

        if (diff === 0) return 1;
        if (diff <= 2) return 0.95;
        if (diff <= 4) return 0.85;
        if (diff <= 6) return 0.75;
        if (diff <= 10) return 0.6;
        return Math.max(0.3, 1 - diff / maxLen);
    }

    /**
     * 计算问题关键词的字符重叠度
     * @param {string} query - 用户问题
     * @param {string} itemQuestion - 知识库问题
     * @returns {number} - 重叠度 (0-1)
     */
    calculateOverlapSimilarity(query, itemQuestion) {
        // 提取所有2字以上的词组
        const getNgrams = (str) => {
            const ngrams = new Set();
            const clean = str.replace(/[吗呢吧呀啊么？?。，,！!、\s]/g, '');
            for (let i = 0; i < clean.length - 1; i++) {
                ngrams.add(clean.substring(i, i + 2));
            }
            return ngrams;
        };

        const ngrams1 = getNgrams(query);
        const ngrams2 = getNgrams(itemQuestion);

        // 计算交集
        let intersection = 0;
        ngrams1.forEach(ng => {
            if (ngrams2.has(ng)) intersection++;
        });

        // Jaccard相似度
        const union = ngrams1.size + ngrams2.size - intersection;
        return union > 0 ? intersection / union : 0;
    }

    /**
     * 提取问题的核心关键词（通常是名词，在问题末尾）
     * @param {string} question - 问题
     * @returns {Array} - 核心关键词
     */
    extractCoreKeywords(question) {
        // 移除疑问词
        const withoutQuestionWords = question
            .replace(/[吗呢吧呀啊么什么|哪些|怎样|如何|为什么|是不是]/g, ' ')
            .trim();

        // 按空格分割，取最后几个词
        const words = withoutQuestionWords.split(/\s+/);
        const lastWords = words.slice(-3); // 取最后3个词作为核心

        return lastWords.filter(w => w.length >= 2);
    }

    /**
     * 动态添加新的问答对
     * @param {string} question - 新问题
     * @param {string} answer - 对应答案
     */
    addKnowledge(question, answer) {
        const newItem = {
            question: question,
            answer: answer,
            keywords: this.extractKeywords(question),
            tfVector: null
        };

        this.knowledgeBase.push(newItem);
        
        // 重新计算
        this.buildVocabulary();
        this.calculateIDF();
        this.calculateTFIDF();

        console.log(`新知识已添加: ${question}`);
    }

    /**
     * 批量添加问答对
     * @param {Array} qaPairs - 问答对数组 [{question, answer}]
     */
    batchAddKnowledge(qaPairs) {
        qaPairs.forEach(pair => {
            const newItem = {
                question: pair.question,
                answer: pair.answer,
                keywords: this.extractKeywords(pair.question),
                tfVector: null
            };
            this.knowledgeBase.push(newItem);
        });

        // 重新计算
        this.buildVocabulary();
        this.calculateIDF();
        this.calculateTFIDF();

        console.log(`批量添加了 ${qaPairs.length} 条新知识`);
    }

    /**
     * 导出知识库
     * @returns {string} - JSON格式的知识库
     */
    exportKnowledgeBase() {
        const exportData = this.knowledgeBase.map(item => ({
            question: item.question,
            answer: item.answer
        }));

        return JSON.stringify(exportData, null, 2);
    }

    /**
     * 从JSON导入知识库
     * @param {string} jsonData - JSON格式的知识库
     */
    importKnowledgeBase(jsonData) {
        try {
            const data = JSON.parse(jsonData);
            const questions = data.map(item => item.question);
            const answers = data.map(item => item.answer);
            this.initialize(questions, answers);
        } catch (error) {
            console.error('导入知识库失败:', error);
        }
    }

    /**
     * 获取知识库统计信息
     * @returns {Object} - 统计信息
     */
    getStatistics() {
        return {
            totalQuestions: this.knowledgeBase.length,
            vocabularySize: this.vocabulary.size,
            initialized: this.initialized
        };
    }
}

// 全局实例
const chatbot = new IntelligentChatbot();

// 全局学习方法供前端调用
/**
 * 机器人学习新知识
 * @param {string} question - 问题
 * @param {string} answer - 答案
 */
function chatbotLearn(question, answer) {
    chatbot.learn(question, answer);
}

/**
 * 机器人纠正答案
 * @param {string} question - 问题
 * @param {string} newAnswer - 新答案
 */
function chatbotCorrect(question, newAnswer) {
    chatbot.correct(question, newAnswer);
}

/**
 * 获取机器人已学习的知识数量
 */
function chatbotGetLearnedCount() {
    return chatbot.userLearned.size;
}

/**
 * 清除所有用户学习的知识
 */
function chatbotClearLearned() {
    chatbot.userLearned.clear();
    localStorage.removeItem('chatbot_user_learned');
    console.log('已清除所有用户学习的知识');
}

    /**
     * 处理用户输入：根据上下文判断是回答还是纠正
     * @param {string} input - 用户输入
     * @returns {Object} - {type: 'answer'|'question', content: string, question: string|null}
     */
    function chatbotProcessInput(input) {
        // 如果是纠正
        if (chatbot.isCorrecting(input)) {
            if (chatbot._lastQuestion) {
                return {
                    type: 'correction',
                    question: chatbot._lastQuestion,
                    prompt: '抱歉，请您告诉我正确的答案是什么？'
                };
            }
        }

        // 如果上一次是纠正提示，用户可能正在给出正确答案
        if (chatbot._waitingForCorrection && chatbot._lastQuestion) {
            // 用户给出了正确答案，学习它
            chatbot.learn(chatbot._lastQuestion, input);
            chatbot._waitingForCorrection = false;

            const learnedQuestion = chatbot._lastQuestion;
            const learnedAnswer = input;

            // 保存到云端（localStorage）
            chatbot.saveUserLearned();

            // 清空上一次的记录
            chatbot._lastQuestion = null;
            chatbot._lastAnswer = null;

            return {
                type: 'learned',
                question: learnedQuestion,
                answer: learnedAnswer
            };
        }

        return {
            type: 'question',
            content: input
        };
    }

    /**
     * 机器人回复处理器（供前端调用）
     * @param {string} userInput - 用户输入
     * @returns {Object} - 机器人回复结果
     */
    function chatbotReply(userInput) {
        // 处理纠正
        const processed = chatbotProcessInput(userInput);

        if (processed.type === 'correction') {
            chatbot._waitingForCorrection = true;
            return {
                needCorrection: true,
                prompt: processed.prompt
            };
        }

        if (processed.type === 'learned') {
            return {
                learned: true,
                question: processed.question,
                answer: processed.answer,
                message: `我知道了！\n\n` +
                         `问题：${processed.question}\n` +
                         `答案：${processed.answer}\n\n` +
                         `谢谢您，我已经学会了！`
            };
        }

        // 正常问答
        const result = chatbot.findBestMatch(userInput);
        return {
            result: result
        };
    }
