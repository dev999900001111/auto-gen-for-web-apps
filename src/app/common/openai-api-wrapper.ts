import { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as fs from 'fs';
import fsq from './fsq';
import { TiktokenModel, encoding_for_model } from 'tiktoken';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Configuration, CreateChatCompletionRequest, CreateChatCompletionResponse, OpenAIApi } from "openai";
import { Utils } from "./utils";

const HISTORY_DIRE = `./history`;
const configuration = new Configuration({
    apiKey: process.env['OPENAI_API_KEY'],
    // baseOptions: { timeout: 1200000 },
});
const openai = new OpenAIApi(configuration);


/**
 * OpenAIのAPIを呼び出すラッパークラス
 */
export class OpenAIApiWrapper {

    options: AxiosRequestConfig;
    tokenCountList: TokenCount[] = [];

    constructor() {
        // proxy設定判定用オブジェクト
        const proxyObj: { [key: string]: any } = {
            httpProxy: process.env['http_proxy'] as string || undefined,
            httpsProxy: process.env['https_proxy'] as string || undefined,
        };
        Object.keys(proxyObj).filter(key => !proxyObj[key]).forEach(key => delete proxyObj[key]);
        this.options = Object.keys(proxyObj).filter(key => proxyObj[key]).length > 0 ? {
            proxy: false,
            httpAgent: new HttpsProxyAgent(proxyObj.httpProxy || proxyObj.httpsProxy || ''),
            httpsAgent: new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || ''),
        } : {};
        this.options.responseType = 'stream';

        // this.options = {};
        // console.log(this.options);

        try { fs.mkdirSync(`${HISTORY_DIRE}`, { recursive: true }); } catch (e) { }
        // ヘッダー出力
        console.log(`timestamp               step  R time[ms]  prompt comple model    cost   label`);
    }
    /**
     * OpenAIのAPIを呼び出す関数
     * @param label ラベル
     * @param prompt プロンプト 
     * @param model モデル
     * @param systemMessage システムメッセージ
     * @returns OpenAIのAPIのレスポンス
     */
    call(label: string, prompt: string, model: TiktokenModel = 'gpt-3.5-turbo', systemMessage: string = 'You are an experienced and talented software engineer.', assistantMessage: string = '', streamHandler: (text: string) => void = () => { }): Promise<string> {
        const promise: Promise<string> = new Promise(async (resolve, reject) => {
            const args: CreateChatCompletionRequest = {
                // model: ([0, 1, 4, 5].indexOf(stepNo) !== -1) ? "gpt-4" : "gpt-3.5-turbo",
                model,
                temperature: 0.0,
                messages: [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: prompt },
                ],
                stream: true,
            };

            if (assistantMessage) {
                args.messages.push({ role: 'assistant', content: assistantMessage });
            } else { }

            let completion: AxiosResponse<CreateChatCompletionResponse, any> | null = null;
            let retry = 0;

            // ログ出力用オブジェクト
            const text = args.messages.map(message => `role:\n${message.role}\ncontent:\n${message.content}`).join('\n');
            const tokenCount = new TokenCount(model, encoding_for_model(model).encode(text).length, 0);
            this.tokenCountList.push(tokenCount);

            let bef = Date.now();
            const logString = (stepName: string, error: any = ''): string => {
                const take = numForm(Date.now() - bef, 9);
                const prompt_tokens = numForm(tokenCount.prompt_tokens, 6);
                const completion_tokens = numForm(tokenCount.completion_tokens, 6);

                const costStr = (tokenCount.completion_tokens > 0 ? ('$' + (Math.ceil(tokenCount.cost * 100) / 100).toFixed(2)) : '').padStart(6, ' ');
                const logString = `${Utils.formatDate()} ${stepName.padEnd(5, ' ')} ${retry} ${take} ${prompt_tokens} ${completion_tokens} ${tokenCount.modelShort} ${costStr} ${label} ${error}`;
                fsq.appendFile(`history.log`, `${logString}\n`, {}, () => { });
                return logString;
            };

            console.log(logString('start'));
            // 30秒間隔でリトライ
            while (!completion) {
                try {
                    completion = await openai.createChatCompletion(args, this.options as any) as AxiosResponse<CreateChatCompletionResponse, any>;

                    let tokenBuilder: string = '';
                    (completion.data as any).on('data', (data: any) => {
                        fsq.appendFile(`${HISTORY_DIRE}/${timestamp}-${label}.txt`, data.toString(), {}, () => { });
                        // console.log(data.toString());
                        const lines = data.toString().split('\n').filter((line: string) => line.trim() !== '');
                        for (const line of lines) {
                            const message: string = line.replace(/^data: /, '');
                            if (message === '[DONE]') {
                                // tokenCount.prompt_tokens = completion.data.usage?.prompt_tokens || 0;
                                // tokenCount.completion_tokens = completion.data.usage?.completion_tokens || 0;
                                tokenCount.cost = tokenCount.calcCost();
                                console.log(logString('fine'));
                                resolve(tokenBuilder);
                                return tokenBuilder; // Stream finished
                            }
                            try {
                                const parsed = JSON.parse(message);
                                // console.log(parsed);
                                Object.keys(parsed.choices[0].delta).forEach(
                                    key => {
                                        tokenCount.completion_tokens++;
                                        if (key === 'content') {
                                            streamHandler(parsed.choices[0].delta[key]);
                                            tokenBuilder += parsed.choices[0].delta[key];
                                        } else {
                                            // content以外は無視
                                        }
                                    }
                                );
                            } catch (error) {
                                console.error('Could not JSON parse stream message', message, error);
                                reject(error);
                            }
                        }
                    });

                    // ファイルに書き出す
                    const timestamp = Utils.formatDate(new Date(), 'yyyyMMddHHmmssSSS');
                    fsq.writeFile(`${HISTORY_DIRE}/${timestamp}-${label}.json`, JSON.stringify({ args, completion }, Utils.genJsonSafer()), {}, (err) => { });
                } catch (error) {
                    // 30秒間隔でリトライ
                    console.log(logString('error', error));
                    retry++;
                    completion = null;
                    await wait(30000);
                }
                if (retry > 10) {
                    console.log(logString('error', 'retry over'));
                    reject('retry over');
                }
            }
        });
        return promise;
    }

    public total(): { [key: string]: TokenCount } {
        return this.tokenCountList.reduce((prev: { [key: string]: TokenCount }, current: TokenCount) => {
            const tokenCount = prev[current.modelShort] || new TokenCount(current.model, 0, 0);
            tokenCount.add(current);
            prev.all.add(current);
            prev[current.modelShort] = tokenCount;
            return prev;
        }, { 'all': new TokenCount('all', 0, 0) });
    }
}


/**
 * トークン数とコストを計算するクラス
 */
export class TokenCount {

    // モデル名とコストの対応表
    static COST_TABLE: { [key: string]: { prompt: number, completion: number } } = {
        'all     ': { prompt: 0.000, completion: 0.000, },
        'gpt3.5  ': { prompt: 0.002, completion: 0.002, },
        'gpt4    ': { prompt: 0.030, completion: 0.060, },
        'gpt4-32k': { prompt: 0.060, completion: 0.120, },
    };

    // コスト
    public cost: number = 0;

    // モデル名の短縮形
    public modelShort: string;

    /**
     * @param model: 'gpt-3.5-turbo'|'gpt-4' モデル名
     * @param prompt_tokens: number  プロンプトのトークン数
     * @param completion_tokens: number コンプリーションのトークン数
     * @returns TokenCount インスタンス
     */
    constructor(
        public model: string,
        public prompt_tokens: number = 0,
        public completion_tokens: number = 0,
    ) {
        this.modelShort = 'all     ';
        if (model.includes('gpt-4')) {
            this.modelShort = model.includes('32k') ? 'gpt4-32k' : 'gpt4    ';
        } else if (model.includes('gpt-3.5')) {
            this.modelShort = 'gpt3.5  ';
        }
    }

    calcCost(): number {
        this.cost = (
            TokenCount.COST_TABLE[this.modelShort].prompt * this.prompt_tokens +
            TokenCount.COST_TABLE[this.modelShort].completion * this.completion_tokens
        ) / 1000;
        return this.cost;
    }

    /**
     * トークン数とコストを加算する
     * @param obj 
     * @returns 
     */
    add(obj: TokenCount): TokenCount {
        this.cost += obj.cost;
        this.prompt_tokens += obj.prompt_tokens;
        this.completion_tokens += obj.completion_tokens;
        return this;
    }

    /** 
     * @returns string ログ出力用の文字列
     */
    toString(): string {
        return `${this.modelShort.padEnd(8)} ${this.prompt_tokens.toLocaleString().padStart(6, ' ')} ${this.completion_tokens.toLocaleString().padStart(6, ' ')} ${('$' + (Math.ceil(this.cost * 100) / 100).toFixed(2)).padStart(6, ' ')}`;
    }
}

function numForm(dec: number, len: number) { return (dec || '').toLocaleString().padStart(len, ' '); };
async function wait(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

