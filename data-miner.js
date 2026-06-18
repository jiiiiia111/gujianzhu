/**
 * 数据挖掘工具 - 从文本中提取问答对
 * 
 * 功能：
 * 1. 从文档中提取问答对
 * 2. 生成训练数据
 * 3. 数据清洗和预处理
 */
class DataMiner {
    constructor() {
        this.patterns = {
            // 问答模式
            qa: [
                /^question:\s*(.+)$/im,
                /^问题:\s*(.+)$/im,
                /^问:\s*(.+)$/im,
                /^q:\s*(.+)$/im,
                  ],
            answer: [
                /^answer:\s*(.+)$/im,
                /^答案:\s*(.+)$/im,
                /^答:\s*(.+)$/im,
                /^a:\s*(.+)$/im,
                   ],
            // 关键词模式
            keywords: /^keywords:\s*(.+)$/im,
            // 主题分割
            section: /^#{1,3}\s*(.+)$/gm
        };
    }
    /**
     * 从Markdown文件提取问答对
     * @param {string} markdownText - Markdown文本
     * @returns {Array} - 问答对数组
     */
    extractFromMarkdown(markdownText) {
        const qaPairs = [];
        const sections = markdownText.split(/^##\s*.*$/gm);
        for (const section of sections) {
            const pairs = this.parseQASection(section);
            qaPairs.push(...pairs);
        }
        return qaPairs;
    }
    /**
     * 解析问答章节
     * @param {string} text - 文本
     * @returns {Array} - 问答对数组
     */
    parseQASection(text) 
  {
        const pairs = [ ];
        const lines = text.split('\n').filter(line => line.trim());
        let currentQuestion = null;
        let currentAnswer = [ ];
        let currentKeywords = null;
        let currentBrief = null;
        for (const line of lines) {
            const trimmedLine = line.trim();
            // 检查是否是问题
            const questionMatch = this.matchQuestion(trimmedLine);
            if (questionMatch) {
                // 保存前一个问答对
                if (currentQuestion && currentAnswer.length > 0) {
                    pairs.push({
                        question: currentQuestion,
                        answer: currentAnswer.join('\n'),
                        brief: currentBrief,
                        keywords: currentKeywords });
                }
                // 开始新的问答对
                currentQuestion = questionMatch;
                currentAnswer = [];
                currentKeywords = null;
                currentBrief = null;
                continue;
            }
            
            // 检查是否是精简答案
            const briefMatch = this.matchBrief(trimmedLine);
            if (briefMatch) {
                currentBrief = briefMatch;
                continue;
            }
           // 检查是否是答案
            const answerMatch = this.matchAnswer(trimmedLine);
            if (answerMatch) {
                currentAnswer.push(answerMatch);
                continue;
            }
            
            // 检查是否是关键词
            const keywordsMatch = this.matchKeywords(trimmedLine);
            if (keywordsMatch) {
                currentKeywords = keywordsMatch;
                continue;
            }
            
            // 如果已有问题，将非空的行作为答案的一部分
            if (currentQuestion && trimmedLine && !this.isSectionHeader(trimmedLine)) {
                currentAnswer.push(trimmedLine);
            }
        }   
        // 保存最后一个问答对
        if (currentQuestion && currentAnswer.length > 0) {
            pairs.push({
                question: currentQuestion,
                answer: currentAnswer.join('\n'),
                brief: currentBrief,
                keywords: currentKeywords
            });
        }
     return pairs;
    }
    /**
     * 匹配精简答案
     * @param {string} line - 文本行
     * @returns {string|null} - 精简答案内容
     */
    matchBrief(line) {
        for (const pattern of this.patterns.brief) 
         {
            const match = line.match(pattern);
            if (match) return match[1];
          }
        return null;
    }
    /**
     * 匹配问题
     * @param {string} line - 文本行
     * @returns {string|null} - 问题内容
     */
    matchQuestion(line) {
        for (const pattern of this.patterns.qa) {
            const match = line.match(pattern);
            if (match) return match[1];
        }
        // 检查是否是问号结尾的行
        if (line.endsWith('？') || line.endsWith('?'))
       {
            return line;
        }
        return null;
    }
    /**
     * 匹配答案
     * @param {string} line - 文本行
     * @returns {string|null} - 答案内容
     */
    matchAnswer(line) {
        for (const pattern of this.patterns.answer) {
            const match = line.match(pattern);
            if (match) return match[1];
        }
        return null;
    }
    /**
     * 匹配关键词
     * @param {string} line - 文本行
     * @returns {string|null} - 关键词内容
     */
    matchKeywords(line) {
        const match = line.match(this.patterns.keywords);
        return match ? match[1] : null;
    }
    /**
     * 检查是否是章节标题
     * @param {string} line - 文本行
     * @returns {boolean} - 是否是章节标题
     */
    isSectionHeader(line) {
        return /^#{1,3}\s/.test(line);
    }
    /**
     * 生成训练数据
     * @param {Array} qaPairs - 问答对数组
     * @returns {Array} - 训练数据数组
     */
    generateTrainingData(qaPairs) {
        const trainingData = [];
        for (const pair of qaPairs) {
            // 原始问答对
            trainingData.push({
                question: pair.question,
                answer: pair.answer,
                keywords: pair.keywords
            });
            // 生成变体问题
            const variations = this.generateQuestionVariations(pair.question);
            for (const variation of variations)
            {
                    trainingData.push({
                    question: variation,
                    answer: pair.answer,
                    keywords: pair.keywords； });
            }
        }
        return trainingData;
    }
    /**
     * 生成问题变体
     * @param {string} question - 原始问题
     * @returns {Array} - 问题变体数组
     */
    generateQuestionVariations(question) {
        const variations = [ ];
        // 添加"请问"前缀
        variations.push(`请问${question}`);
        variations.push(`能不能告诉我${question}`);
        // 转换疑问词
        let modifiedQuestion = question;
        modifiedQuestion = modifiedQuestion.replace(/是什么/g, '是什么意思');
        modifiedQuestion = modifiedQuestion.replace(/有哪些/g, '包括哪些');
        modifiedQuestion = modifiedQuestion.replace(/怎么/g, '如何');
       if (modifiedQuestion !== question) {
            variations.push(modifiedQuestion);
        }
        // 提取关键词重新组织
        const keywords = this.extractKeywords(question);
        if (keywords.length >= 2) {
            variations.push(`关于${keywords[0]}，${keywords[1]}是什么？`);
        }
        return variations;
    }

    /**
     * 提取关键词
     * @param {string} text - 文本
     * @returns {Array} - 关键词数组
     */
    extractKeywords(text) {
        // 简化的关键词提取
        const keywords = [];
        const commonWords = ['的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '什么', '怎么', '如何'];
        // 按标点分割
        const segments = text.split(/[，。！？、；：""''（）\[\]\{\}.,!?;:()\[\]{}]/g);
        for (const segment of segments) {
            const words = segment.trim().split(/\s+/);
            for (const word of words) {
                if (word && !commonWords.includes(word) && word.length >= 2) {
                    keywords.push(word);
                }
            }
        }
        return keywords;
    }
   /**
     * 数据清洗
     * @param {Array} qaPairs - 问答对数组
     * @returns {Array} - 清洗后的问答对数组
     */
    cleanData(qaPairs) {
        return qaPairs
            .filter(pair => pair.question && pair.answer)
            .filter(pair => pair.question.length > 2 && pair.answer.length > 10)
            .map(pair => ({
                question: this.cleanText(pair.question),
                answer: this.cleanText(pair.answer),
                keywords: pair.keywords ? this.cleanKeywords(pair.keywords) : null
            }));
    }

    /**
     * 清洗文本
     * @param {string} text - 文本
     * @returns {string} - 清洗后的文本
     */
    cleanText(text) {
        return text
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/["""''()（）]/g, '');
    }
    /**
     * 清洗关键词
     * @param {string} keywordsStr - 关键词字符串
     * @returns {Array} - 关键词数组
     */
    cleanKeywords(keywordsStr) {
        if (!keywordsStr) return null;
        return keywordsStr
            .split(/[，,、]/)
            .map(k => k.trim())
            .filter(k => k.length > 0);
    }
    /**
     * 导出为JSON
     * @param {Array} data - 数据数组
     * @returns {string} - JSON字符串
     */
    exportToJSON(data) {
        return JSON.stringify(data, null, 2);
    }
    /**
     * 从JSON导入
     * @param {string} jsonString - JSON字符串
     * @returns {Array} - 数据数组
     */
    importFromJSON(jsonString) {
        try {
            return JSON.parse(jsonString);
        } catch (error) {
            console.error('JSON解析失败:', error);
            return [ ];
        }
    }
}
// 全局实例
const dataMiner = new DataMiner( );
