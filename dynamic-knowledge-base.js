/**
 * 动态知识库管理系统
 * 
 * 功能：
 * 1. 动态记录用户问题
 * 2. 动态添加答案
 * 3. 自动搜索和匹配
 * 4. 数据持久化
 */

class DynamicKnowledgeBase {
    constructor() {
        this.knowledgeBase = this.loadKnowledgeBase();
        this.unansweredQuestions = this.loadUnansweredQuestions();
        this.questionHistory = this.loadQuestionHistory();
    }

    /**
     * 从localStorage加载知识库
     */
    loadKnowledgeBase() {
        try {
            const data = localStorage.getItem('dynamic-knowledge-base');
            return data ? JSON.parse(data) : [];
        } catch (error) {
            console.error('加载知识库失败:', error);
            return [];
        }
    }

    /**
     * 保存知识库到localStorage
     */
    saveKnowledgeBase() {
        try {
            localStorage.setItem('dynamic-knowledge-base', JSON.stringify(this.knowledgeBase));
        } catch (error) {
            console.error('保存知识库失败:', error);
        }
    }

    /**
     * 加载未回答问题
     */
    loadUnansweredQuestions() {
        try {
            const data = localStorage.getItem('unanswered-questions');
            return data ? JSON.parse(data) : [];
        } catch (error) {
            console.error('加载未回答问题失败:', error);
            return [];
        }
    }

    /**
     * 保存未回答问题
     */
    saveUnansweredQuestions() {
        try {
            localStorage.setItem('unanswered-questions', JSON.stringify(this.unansweredQuestions));
        } catch (error) {
            console.error('保存未回答问题失败:', error);
        }
    }

    /**
     * 加载问题历史
     */
    loadQuestionHistory() {
        try {
            const data = localStorage.getItem('question-history');
            return data ? JSON.parse(data) : [];
        } catch (error) {
            console.error('加载问题历史失败:', error);
            return [];
        }
    }

    /**
     * 保存问题历史
     */
    saveQuestionHistory() {
        try {
            localStorage.setItem('question-history', JSON.stringify(this.questionHistory));
        } catch (error) {
            console.error('保存问题历史失败:', error);
        }
    }

    /**
     * 动态添加新的问答对
     * @param {string} question - 问题
     * @param {string} answer - 答案
     * @returns {boolean} - 是否添加成功
     */
    addQuestionAnswer(question, answer) {
        if (!question || !answer) {
            console.error('问题和答案不能为空');
            return false;
        }

        // 检查是否已存在相同问题，如果存在则更新答案
        const existingIndex = this.knowledgeBase.findIndex(qa => qa.question === question.trim());
        if (existingIndex >= 0) {
            this.knowledgeBase[existingIndex].answer = answer.trim();
            this.knowledgeBase[existingIndex].updatedAt = new Date().toISOString();
            this.saveKnowledgeBase();
            console.log('更新现有问题的答案:', question);
            return true;
        }

        const newQA = {
            id: Date.now(),
            question: question.trim(),
            answer: answer.trim(),
            keywords: this.extractKeywords(question),
            createdAt: new Date().toISOString(),
            usageCount: 0
        };

        this.knowledgeBase.push(newQA);
        this.saveKnowledgeBase();

        // 从未回答问题列表中移除
        this.removeFromUnanswered(question);

        console.log('新知识已添加:', newQA);
        return true;
    }

    /**
     * 动态搜索答案
     * @param {string} question - 用户问题
     * @returns {Object|null} - 匹配的问答对
     */
    searchAnswer(question) {
        if (!question) return null;

        // 记录问题历史
        this.recordQuestionHistory(question);

        // 提取问题关键词
        const queryKeywords = this.extractKeywords(question);

        // 计算相似度
        let bestMatch = null;
        let bestScore = 0;

        for (const qa of this.knowledgeBase) {
            const score = this.calculateSimilarity(question, qa, queryKeywords);
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = qa;
            }
        }

        // 如果找到匹配且分数超过阈值
        if (bestMatch && bestScore > 0.2) {
            // 增加使用次数
            bestMatch.usageCount++;
            this.saveKnowledgeBase();

            console.log(`找到匹配，得分: ${bestScore.toFixed(3)}, 问题: ${bestMatch.question}`);
            return bestMatch;
        }

        // 没有找到匹配
        console.log('未找到匹配，最高得分:', bestScore.toFixed(3));
        return null;
    }

    /**
     * 计算相似度
     * @param {string} query - 查询问题
     * @param {Object} qa - 知识库条目
     * @param {Array} queryKeywords - 查询关键词
     * @returns {number} - 相似度分数 (0-1)
     */
    calculateSimilarity(query, qa, queryKeywords) {
        // 字符串相似度
        const stringSim = this.stringSimilarity(query, qa.question);

        // 关键词匹配度
        const keywordSim = this.keywordSimilarity(queryKeywords, qa.keywords);

        // 综合评分
        return stringSim * 0.5 + keywordSim * 0.5;
    }

    /**
     * 字符串相似度（基于编辑距离）
     */
    stringSimilarity(str1, str2) {
        const distance = this.levenshteinDistance(str1, str2);
        const maxLen = Math.max(str1.length, str2.length);
        if (maxLen === 0) return 1;
        return 1 - distance / maxLen;
    }

    /**
     * 编辑距离
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
                        dp[i - 1][j] + 1,
                        dp[i][j - 1] + 1,
                        dp[i - 1][j - 1] + 1
                    );
                }
            }
        }

        return dp[m][n];
    }

    /**
     * 关键词相似度
     */
    keywordSimilarity(queryKeywords, qaKeywords) {
        if (!qaKeywords || qaKeywords.length === 0) return 0;
        if (queryKeywords.length === 0) return 0;

        let matchCount = 0;
        for (const keyword of queryKeywords) {
            if (qaKeywords.includes(keyword)) {
                matchCount++;
            }
        }

        return matchCount / queryKeywords.length;
    }

    /**
     * 提取关键词
     */
    extractKeywords(text) {
        // 简化的关键词提取
        const keywords = [];
        const commonWords = ['的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', 
                           '什么', '怎么', '如何', '哪个', '哪些', '吗', '呢', '呀'];

        const segments = text.split(/[，。！？、；：""''（）\[\]\{\}.,!?;:()\[\]{}]/g);

        for (const segment of segments) {
            const words = segment.trim().split(/\s+/);
            for (const word of words) {
                if (word && word.length >= 2 && !commonWords.includes(word)) {
                    keywords.push(word);
                }
            }
        }

        return keywords;
    }

    /**
     * 添加到未回答问题列表
     */
    addToUnanswered(question) {
        // 检查是否已存在
        const exists = this.unansweredQuestions.some(q => q.question === question);
        if (exists) {
            // 增加提问次数
            const q = this.unansweredQuestions.find(q => q.question === question);
            q.askCount++;
            q.lastAskedAt = new Date().toISOString();
        } else {
            this.unansweredQuestions.push({
                id: Date.now(),
                question: question.trim(),
                askCount: 1,
                firstAskedAt: new Date().toISOString(),
                lastAskedAt: new Date().toISOString()
            });
        }
        this.saveUnansweredQuestions();
    }

    /**
     * 记录问题（用于未回答的问题）
     */
    recordQuestion(question) {
        // 添加到未回答问题列表
        this.addToUnanswered(question);
        
        // 记录到历史
        this.recordQuestionHistory(question);
    }

    /**
     * 从未回答问题列表中移除
     */
    removeFromUnanswered(question) {
        this.unansweredQuestions = this.unansweredQuestions.filter(q => q.question !== question);
        this.saveUnansweredQuestions();
    }

    /**
     * 记录问题历史
     */
    recordQuestionHistory(question) {
        this.questionHistory.push({
            question: question.trim(),
            askedAt: new Date().toISOString()
        });

        // 只保留最近100条历史
        if (this.questionHistory.length > 100) {
            this.questionHistory = this.questionHistory.slice(-100);
        }

        this.saveQuestionHistory();
    }

    /**
     * 获取热门问题
     */
    getPopularQuestions(limit = 10) {
        return this.knowledgeBase
            .sort((a, b) => b.usageCount - a.usageCount)
            .slice(0, limit);
    }

    /**
     * 获取未回答问题
     */
    getUnansweredQuestions() {
        return this.unansweredQuestions
            .sort((a, b) => b.askCount - a.askCount);
    }

    /**
     * 批量导入问答对
     */
    batchImport(qaArray) {
        qaArray.forEach(item => {
            this.addQuestionAnswer(item.question, item.answer);
        });
    }

    /**
     * 导出知识库
     */
    exportKnowledgeBase() {
        return JSON.stringify(this.knowledgeBase, null, 2);
    }

    /**
     * 导入知识库
     */
    importKnowledgeBase(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            this.knowledgeBase = data;
            this.saveKnowledgeBase();
            return true;
        } catch (error) {
            console.error('导入知识库失败:', error);
            return false;
        }
    }

    /**
     * 获取统计信息
     */
    getStatistics() {
        return {
            totalQuestions: this.knowledgeBase.length,
            unansweredQuestions: this.unansweredQuestions.length,
            questionHistory: this.questionHistory.length,
            topQuestions: this.getPopularQuestions(5)
        };
    }

    /**
     * 清空所有数据
     */
    clearAll() {
        this.knowledgeBase = [];
        this.unansweredQuestions = [];
        this.questionHistory = [];
        this.saveKnowledgeBase();
        this.saveUnansweredQuestions();
        this.saveQuestionHistory();
        localStorage.removeItem('dynamic-knowledge-base');
        localStorage.removeItem('unanswered-questions');
        localStorage.removeItem('question-history');
    }
}
