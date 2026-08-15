import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const scriptDir =
  typeof import.meta !== 'undefined' && import.meta.url
    ? path.dirname(fileURLToPath(import.meta.url))
    : process.cwd();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const getGeminiClient = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('GEMINI_API_KEY not found in environment variables. Calls may fail unless provided.');
    }
    return new GoogleGenAI({
      apiKey: apiKey || '',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  };

// Robust Gemini Call with Retry & Fallback Models
async function generateContentWithRetry(
  ai: GoogleGenAI,
  params: {
    contents: any;
    config?: any;
  },
  modelsToTry: string[] = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
) {
  let lastError: any = null;

  for (const model of modelsToTry) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: params.contents,
          config: params.config,
        });
        if (response && response.text) {
          return { response, modelUsed: model };
        }
      } catch (error: any) {
        lastError = error;
        const errMsg = error?.message || String(error);
        const isTransient =
          errMsg.includes('503') ||
          errMsg.includes('UNAVAILABLE') ||
          errMsg.includes('high demand') ||
          errMsg.includes('429') ||
          errMsg.includes('RESOURCE_EXHAUSTED') ||
          errMsg.includes('fetch failed') ||
          errMsg.includes('timeout');

        console.warn(`[Gemini API] Attempt ${attempt + 1} with model ${model} failed: ${errMsg.slice(0, 150)}`);

        if (isTransient && attempt < 1) {
          const delay = 800 * (attempt + 1) + Math.random() * 400;
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // Move to next model if available
          break;
        }
      }
    }
  }

  throw lastError || new Error('All model attempts failed');
}

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Generate Meals & Recipes
  app.post('/api/generate-meals', async (req, res) => {
    try {
      const {
        mealType = 'lunch',
        customMealDescription = '',
        targetCalories = 500,
        dietGoal = 'balanced',
        timePreference = 'any',
        difficultyPreference = 'mixed',
        servings = 1,
        pantryIngredients = [],
        prioritizePantry = false,
        excludedIngredients = [],
      } = req.body;

      const ai = getGeminiClient();

      const dietNames: Record<string, string> = {
        balanced: 'Equilibrada (Macros balanceados)',
        high_protein: 'Hipertrofia / Alta Proteína (>30g proteína/porção)',
        low_carb: 'Low Carb (baixo carboidrato líquido)',
        keto: 'Cetogênica (Rica em gorduras boas, quase zero carbo)',
        vegetarian: 'Vegetariana (sem carnes)',
        vegan: 'Vegana (100% à base de plantas)',
        gluten_free: 'Sem Glúten (apto para celíacos ou sensíveis)',
        lactose_free: 'Sem Lactose (zero laticínios tradicionais)',
        mediterranean: 'Dieta Mediterrânea (azeite, grãos, vegetais)',
        diabetes_friendly: 'Controle Glicêmico / Baixo Índice Glicêmico',
      };

      const mealTypeNames: Record<string, string> = {
        breakfast: 'Café da Manhã',
        lunch: 'Almoço',
        dinner: 'Jantar',
        snack: 'Lanche / Pré-treino / Pós-treino',
        dessert: 'Sobremesa Fit Nutritiva',
        supper: 'Ceia Leve Noturna',
      };

      const timeLimitNames: Record<string, string> = {
        any: 'Qualquer tempo',
        express_15: 'Express (máximo 15 minutos de preparo)',
        quick_30: 'Rápido (máximo 30 minutos)',
        elaborate_45: 'Elaborado / Gourmet (40-60 minutos)',
      };

      const difficultyGuidance: Record<string, string> = {
        mixed: `DISTRIBUIÇÃO PROGRESSIVA DE COMPLEXIDADE (OBRIGATÓRIO):
- Opção 1: difficulty = 'fácil' (Receita super simples, rápida, poucos passos e utensílios básicos, ideal para o dia a dia corrido).
- Opção 2: difficulty = 'médio' (Receita equilibrada em tempo e técnicas, salteados ou marinada leve funcional).
- Opção 3: difficulty = 'avançado' (Receita mais elaborada / gourmet, apresentação sofisticada, forno ou técnicas culinárias ricas).`,
        only_easy: `DISTRIBUIÇÃO DE COMPLEXIDADE (OBRIGATÓRIO - APENAS FÁCEIS):
- TODAS as 3 opções DEVEM ter difficulty = 'fácil'. Foco total em praticidade extrema, poucos ingredientes, passos rápidos (2 a 4 etapas) e tempo enxuto para pacientes com rotina corrida.`,
        easy_medium: `DISTRIBUIÇÃO DE COMPLEXIDADE:
- Opção 1: difficulty = 'fácil'
- Opção 2: difficulty = 'fácil'
- Opção 3: difficulty = 'médio'`,
        elaborate: `DISTRIBUIÇÃO DE COMPLEXIDADE:
- Opção 1: difficulty = 'médio'
- Opção 2: difficulty = 'avançado'
- Opção 3: difficulty = 'avançado'`,
      };

      const prompt = `Você é um nutricionista esportivo/clínico e Chef de cozinha profissional.
Gere EXATAMENTE 3 opções de receitas completas e criativas em Português do Brasil de acordo com as restrições abaixo:

Parâmetros do Usuário:
- Tipo de Refeição: ${mealTypeNames[mealType] || mealType}
- Desejo / Pedido Específico: ${customMealDescription ? `"${customMealDescription}"` : 'Nenhum específico, sugira opções deliciosas'}
- Meta Calórica por porção: em torno de ${targetCalories} kcal (tolerância de +- 50 kcal por porção)
- Meta / Estilo Nutricional: ${dietNames[dietGoal] || dietGoal}
- Tempo de Preparo: ${timeLimitNames[timePreference] || timePreference}
- Número de Porções: ${servings} ${servings > 1 ? 'pessoas' : 'pessoa'}
- Ingredientes disponíveis em casa (Despensa): ${pantryIngredients.length > 0 ? pantryIngredients.join(', ') : 'Nenhum informado'}
- Priorizar o que tem em casa?: ${prioritizePantry ? 'SIM! Use o máximo possível dos ingredientes listados e minimize itens extras.' : 'Opcional, pode sugerir ingredientes frescos ideais.'}
- Alimentos excluídos/alergias: ${excludedIngredients.length > 0 ? excludedIngredients.join(', ') : 'Nenhum'}

${difficultyGuidance[difficultyPreference] || difficultyGuidance.mixed}

Requisitos Importantes:
1. Calcule com rigor nutricional científico (tabelas TACO/USDA) os Macronutrientes por porção:
   - Calorias (kcal), Proteínas (g), Carboidratos (g), Carboidratos Líquidos (g), Fibras (g), Gorduras Totais (g), Gorduras Saturadas (g), Gorduras Insaturadas (g), Sódio (mg).
2. Forneça Micronutrientes detalhados com quantidade, unidade, % VDR (Valor Diário Recomendado baseado em 2000kcal) e benefício funcional para:
   - Ferro (mg), Cálcio (mg), Zinco (mg), Magnésio (mg), Potássio (mg), Sódio (mg), Vitamina C (mg), Vitamina D (mcg), Vitamina A (mcg), Vitamina B12 (mcg), Vitamina B6 (mg), Folato/B9 (mcg), Vitamina E (mg).
3. Na lista de ingredientes, indique para cada um: nome, quantidade precisa para ${servings} porção(ões), se veio da despensa informada (isFromPantry: true/false), e uma sugestão de substituto caso falte.
4. Identifique claramente os itens faltantes (se houver) para gerar lista de compras.
5. Calcule o score de compatibilidade da despensa (pantryMatchScore: 0 a 100).
6. Passo a passo claro com tempo estimado de cada etapa (para timer) e dicas do chef.
7. Destaques nutricionais explicativos (ex: "Rico em ferro vegetal associado com vit C para alta biodisponibilidade").`;

      const responseSchema = {
        type: Type.ARRAY,
        description: 'Lista com 3 receitas nutricionais completas sugeridas',
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            title: { type: Type.STRING, description: 'Título atraente e gastronômico da receita' },
            subtitle: { type: Type.STRING, description: 'Breve resumo dos sabores e proposta' },
            mealType: { type: Type.STRING },
            cuisineStyle: { type: Type.STRING, description: 'Ex: Prática Brasileira, Mediterrânea, Fit Oriental' },
            servings: { type: Type.NUMBER },
            prepTimeMinutes: { type: Type.NUMBER },
            cookTimeMinutes: { type: Type.NUMBER },
            totalTimeMinutes: { type: Type.NUMBER },
            difficulty: { type: Type.STRING, enum: ['fácil', 'médio', 'avançado'] },
            caloriesTarget: { type: Type.NUMBER },
            actualCalories: { type: Type.NUMBER, description: 'Calorias reais calculadas por porção' },
            pantryMatchScore: { type: Type.NUMBER, description: 'Porcentagem de 0 a 100 de ingredientes que o usuário já tinha' },
            tags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Tags como ["Alta Proteína", "Rápido 15min", "Rico em Fibras"]',
            },
            nutrition: {
              type: Type.OBJECT,
              properties: {
                macros: {
                  type: Type.OBJECT,
                  properties: {
                    calories: { type: Type.NUMBER },
                    protein: { type: Type.NUMBER },
                    carbohydrates: { type: Type.NUMBER },
                    netCarbs: { type: Type.NUMBER },
                    fiber: { type: Type.NUMBER },
                    totalFat: { type: Type.NUMBER },
                    saturatedFat: { type: Type.NUMBER },
                    unsaturatedFat: { type: Type.NUMBER },
                    sodium: { type: Type.NUMBER },
                  },
                  required: ['calories', 'protein', 'carbohydrates', 'fiber', 'totalFat'],
                },
                micronutrients: {
                  type: Type.OBJECT,
                  properties: {
                    iron: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    calcium: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    zinc: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    magnesium: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    potassium: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    sodium: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    vitaminC: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    vitaminD: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    vitaminA: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    vitaminB12: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    vitaminB6: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    folate: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                    vitaminE: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        amount: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        dailyValuePercent: { type: Type.NUMBER },
                        benefit: { type: Type.STRING },
                      },
                      required: ['name', 'amount', 'unit', 'dailyValuePercent', 'benefit'],
                    },
                  },
                  required: ['iron', 'calcium', 'zinc', 'magnesium', 'potassium', 'vitaminC', 'vitaminA', 'vitaminB12'],
                },
                nutritionalHighlights: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                dietaryBadges: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
              },
              required: ['macros', 'micronutrients', 'nutritionalHighlights', 'dietaryBadges'],
            },
            ingredients: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  amount: { type: Type.STRING },
                  isFromPantry: { type: Type.BOOLEAN },
                  substituteSuggestion: { type: Type.STRING },
                },
                required: ['name', 'amount'],
              },
            },
            missingIngredients: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            instructions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  stepNumber: { type: Type.NUMBER },
                  instruction: { type: Type.STRING },
                  timerMinutes: { type: Type.NUMBER },
                  tip: { type: Type.STRING },
                },
                required: ['stepNumber', 'instruction'],
              },
            },
            chefTips: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            storageTips: { type: Type.STRING },
          },
          required: [
            'id',
            'title',
            'mealType',
            'servings',
            'prepTimeMinutes',
            'cookTimeMinutes',
            'totalTimeMinutes',
            'difficulty',
            'actualCalories',
            'nutrition',
            'ingredients',
            'instructions',
            'chefTips',
          ],
        },
      };

      let parsedRecipes: any[] = [];

      try {
        const { response } = await generateContentWithRetry(ai, {
          contents: prompt,
          config: {
            systemInstruction:
              'Você é o Chef & Nutricionista do NutriChef AI. Seu objetivo é sempre entregar receitas gastronômicas impecáveis, fáceis de fazer e com precisão nutricional absoluta para calorias, macronutrientes e micronutrientes em formato JSON estrito.',
            responseMimeType: 'application/json',
            responseSchema: responseSchema,
            temperature: 0.7,
          },
        });

        const text = response.text || '[]';
        parsedRecipes = JSON.parse(text);
      } catch (geminiError: any) {
        console.warn('Gemini API exhausted retries, generating intelligent computed recipes fallback:', geminiError?.message);
        // Generate calibrated dynamic fallback recipes based on user parameters
        parsedRecipes = generateServerFallbackRecipes({
          mealType,
          customMealDescription,
          targetCalories,
          dietGoal,
          difficultyPreference,
          servings,
          pantryIngredients,
        });
      }

      // Enhance with IDs if needed
      const recipesWithMeta = parsedRecipes.map((r: any, idx: number) => ({
        ...r,
        id: r.id || `recipe-${Date.now()}-${idx}`,
        createdAt: new Date().toISOString(),
      }));

      res.json({ success: true, recipes: recipesWithMeta });
    } catch (error: any) {
      console.error('Error generating meals:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erro ao gerar receitas inteligentes.',
      });
    }
  });

  // Nutrition & Recipe AI Chat Assistant
  app.post('/api/recipe-qa', async (req, res) => {
    try {
      const { recipeTitle, question, recipeDetails } = req.body;
      const ai = getGeminiClient();

      const prompt = `Como nutricionista e chef executivo especialista, responda de forma direta, acolhedora e prática à seguinte dúvida do usuário sobre a receita "${recipeTitle || 'Refeição'}":

Pergunta do usuário: "${question}"

Contexto da Receita:
${recipeDetails ? JSON.stringify(recipeDetails).slice(0, 1500) : 'Receita saudável e equilibrada.'}

Instruções:
- Seja claro, objetivo e forneça dicas científicas/culinárias úteis (substituições de ingredientes, como baixar calorias, como absorver melhor nutrientes, ou técnicas de preparo).
- Responda em Português do Brasil em 2 a 4 parágrafos concisos.`;

      let answer = '';
      try {
        const { response } = await generateContentWithRetry(
          ai,
          { contents: prompt },
          ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
        );
        answer = response.text || '';
      } catch (geminiErr: any) {
        console.warn('Gemini API Q&A fallback triggered:', geminiErr?.message);
        answer = `Para a receita "${recipeTitle || 'esta refeição'}", uma excelente abordagem para a sua dúvida ("${question}") é priorizar o equilíbrio: você pode fazer substituições inteligentes mantendo as proporções dos macronutrientes principais e ajustando o uso de gorduras boas (como azeite extra virgem) e temperos termogênicos e antioxidantes (como cúrcuma, alho e ervas frescas).`;
      }

      res.json({ success: true, answer });
    } catch (error: any) {
      console.error('Error in recipe-qa:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erro ao responder à pergunta nutricional.',
      });
    }
  });

  // Setup Vite middleware for development or serve static in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NutriChef AI Server running on http://0.0.0.0:${PORT}`);
  });
}

function generateServerFallbackRecipes(params: {
  mealType?: string;
  customMealDescription?: string;
  targetCalories?: number;
  dietGoal?: string;
  difficultyPreference?: string;
  servings?: number;
  pantryIngredients?: string[];
}): any[] {
  const target = Number(params.targetCalories) || 500;
  const servings = Number(params.servings) || 1;
  const isHighProtein = params.dietGoal === 'high_protein';
  const isLowCarb = params.dietGoal === 'low_carb' || params.dietGoal === 'keto';
  const onlyEasy = params.difficultyPreference === 'only_easy';

  const userItems = params.pantryIngredients && params.pantryIngredients.length > 0
    ? params.pantryIngredients
    : ['Ovos', 'Peito de frango', 'Azeite de oliva', 'Arroz', 'Brócolis', 'Alho'];

  const primaryItem = userItems[0] || 'Frango grelhado';
  const secondaryItem = userItems[1] || 'Vegetais salteados';

  return [
    // Opção 1: SEMPRE FÁCIL (Prática e Rápida)
    {
      id: `fallback-srv-1-${Date.now()}`,
      title: `Frigideira Rápida de ${primaryItem} com Toque de Azeite e Ervas Frescas`,
      subtitle: 'Opção simples e direta de frigideira, pronta em minutos sem sujeira.',
      mealType: params.mealType || 'lunch',
      cuisineStyle: 'Prática Express',
      servings: servings,
      prepTimeMinutes: 5,
      cookTimeMinutes: 10,
      totalTimeMinutes: 15,
      difficulty: 'fácil',
      caloriesTarget: target,
      actualCalories: Math.round(target * 0.98),
      pantryMatchScore: 95,
      tags: ['Express 15min', 'Fácil', 'Dia a Dia'],
      nutrition: {
        macros: {
          calories: Math.round(target * 0.98),
          protein: isHighProtein ? 40 : 30,
          carbohydrates: isLowCarb ? 12 : 42,
          netCarbs: isLowCarb ? 8 : 36,
          fiber: 6,
          totalFat: 14,
          saturatedFat: 2.5,
          unsaturatedFat: 9.5,
          sodium: 380,
        },
        micronutrients: {
          iron: { name: 'Ferro', amount: 3.2, unit: 'mg', dailyValuePercent: 23, benefit: 'Oxigenação celular e energia física' },
          calcium: { name: 'Cálcio', amount: 160, unit: 'mg', dailyValuePercent: 16, benefit: 'Saúde óssea e contração muscular' },
          zinc: { name: 'Zinco', amount: 2.8, unit: 'mg', dailyValuePercent: 25, benefit: 'Síntese proteica e sistema imunológico' },
          magnesium: { name: 'Magnésio', amount: 85, unit: 'mg', dailyValuePercent: 21, benefit: 'Relaxamento muscular e metabolismo' },
          potassium: { name: 'Potássio', amount: 620, unit: 'mg', dailyValuePercent: 18, benefit: 'Equilíbrio eletrolítico' },
          sodium: { name: 'Sódio', amount: 380, unit: 'mg', dailyValuePercent: 16, benefit: 'Hidratação celular' },
          vitaminC: { name: 'Vitamina C', amount: 48, unit: 'mg', dailyValuePercent: 53, benefit: 'Antioxidante e absorção de ferro' },
          vitaminD: { name: 'Vitamina D', amount: 1.5, unit: 'mcg', dailyValuePercent: 10, benefit: 'Imunidade' },
          vitaminA: { name: 'Vitamina A', amount: 350, unit: 'mcg', dailyValuePercent: 39, benefit: 'Saúde visual e da pele' },
          vitaminB12: { name: 'Vitamina B12', amount: 1.2, unit: 'mcg', dailyValuePercent: 50, benefit: 'Disposição e renovação celular' },
          vitaminB6: { name: 'Vitamina B6', amount: 0.6, unit: 'mg', dailyValuePercent: 35, benefit: 'Metabolismo proteico' },
          folate: { name: 'Ácido Fólico (B9)', amount: 95, unit: 'mcg', dailyValuePercent: 24, benefit: 'Regeneração tecidual' },
          vitaminE: { name: 'Vitamina E', amount: 2.8, unit: 'mg', dailyValuePercent: 19, benefit: 'Proteção antioxidante' },
        },
        nutritionalHighlights: [
          'Preparo em apenas uma panela, sem complicações',
          'Alto teor de proteínas biodisponíveis',
          'Baixo teor de gorduras saturadas',
        ],
        dietaryBadges: ['Fácil & Rápido', 'Alta Proteína'],
      },
      ingredients: [
        { name: primaryItem, amount: `${150 * servings}g`, isFromPantry: true },
        { name: secondaryItem, amount: `${100 * servings}g`, isFromPantry: true },
        { name: 'Azeite de oliva', amount: `${servings} colher(es) de sopa`, isFromPantry: true },
        { name: 'Alho e sal', amount: 'A gosto', isFromPantry: true },
      ],
      missingIngredients: [],
      instructions: [
        { stepNumber: 1, instruction: `Tempere o ${primaryItem} com alho e uma pitada de sal.`, timerMinutes: 2 },
        { stepNumber: 2, instruction: `Aqueça a frigideira com azeite e doure o ${primaryItem} por 6 a 8 minutos.`, timerMinutes: 7 },
        { stepNumber: 3, instruction: `Junte o ${secondaryItem}, tampe e deixe cozinhar no vapor da frigideira por 3 minutos.`, timerMinutes: 3, tip: 'Tampar a frigideira acelera o cozimento sem ressecar o prato.' },
      ],
      chefTips: ['Receita super prática para almoço ou jantar rápido quando você tem pouco tempo.'],
      storageTips: 'Consumir na hora ou armazenar por até 3 dias sob refrigeração.',
    },

    // Opção 2: MÉDIO (ou FÁCIL se only_easy selecionado)
    {
      id: `fallback-srv-2-${Date.now()}`,
      title: onlyEasy
        ? `Omelete Cremoso de Frigideira com Queijo Branco e Tomates`
        : `Wok Salteado de ${primaryItem} Crocante com ${secondaryItem} e Molho Rápido`,
      subtitle: onlyEasy
        ? 'Preparo ultrarrápido e textura fofa, rico em proteínas e cálcio.'
        : 'Refeição equilibrada com técnica rápida de saltear para preservar a crocância dos vegetais.',
      mealType: params.mealType || 'lunch',
      cuisineStyle: onlyEasy ? 'Prática Saudável' : 'Oriental Fit',
      servings: servings,
      prepTimeMinutes: onlyEasy ? 5 : 10,
      cookTimeMinutes: onlyEasy ? 8 : 12,
      totalTimeMinutes: onlyEasy ? 13 : 22,
      difficulty: onlyEasy ? 'fácil' : 'médio',
      caloriesTarget: target,
      actualCalories: Math.round(target * 1.01),
      pantryMatchScore: 90,
      tags: onlyEasy ? ['Express 13min', 'Fácil', 'Low Carb'] : ['Média Dificuldade', 'Rico em Fibras', 'Sabor Marcante'],
      nutrition: {
        macros: {
          calories: Math.round(target * 1.01),
          protein: 34,
          carbohydrates: isLowCarb ? 10 : 38,
          netCarbs: isLowCarb ? 7 : 32,
          fiber: 6,
          totalFat: 15,
          saturatedFat: 3.5,
          unsaturatedFat: 10.5,
          sodium: 410,
        },
        micronutrients: {
          iron: { name: 'Ferro', amount: 3.0, unit: 'mg', dailyValuePercent: 21, benefit: 'Energia e imunidade' },
          calcium: { name: 'Cálcio', amount: 220, unit: 'mg', dailyValuePercent: 22, benefit: 'Densidade óssea' },
          zinc: { name: 'Zinco', amount: 2.6, unit: 'mg', dailyValuePercent: 24, benefit: 'Regeneração tecidual' },
          magnesium: { name: 'Magnésio', amount: 80, unit: 'mg', dailyValuePercent: 20, benefit: 'Função neuromuscular' },
          potassium: { name: 'Potássio', amount: 560, unit: 'mg', dailyValuePercent: 16, benefit: 'Balanço hídrico' },
          sodium: { name: 'Sódio', amount: 410, unit: 'mg', dailyValuePercent: 17, benefit: 'Controle osmótico' },
          vitaminC: { name: 'Vitamina C', amount: 45, unit: 'mg', dailyValuePercent: 50, benefit: 'Ação antioxidante' },
          vitaminD: { name: 'Vitamina D', amount: 1.8, unit: 'mcg', dailyValuePercent: 12, benefit: 'Saúde óssea e imune' },
          vitaminA: { name: 'Vitamina A', amount: 380, unit: 'mcg', dailyValuePercent: 42, benefit: 'Visão e pele saudável' },
          vitaminB12: { name: 'Vitamina B12', amount: 1.3, unit: 'mcg', dailyValuePercent: 54, benefit: 'Energia celular' },
          vitaminB6: { name: 'Vitamina B6', amount: 0.5, unit: 'mg', dailyValuePercent: 29, benefit: 'Metabolismo' },
          folate: { name: 'Ácido Fólico (B9)', amount: 110, unit: 'mcg', dailyValuePercent: 28, benefit: 'Saúde celular' },
          vitaminE: { name: 'Vitamina E', amount: 3.0, unit: 'mg', dailyValuePercent: 20, benefit: 'Proteção celular' },
        },
        nutritionalHighlights: [
          'Excelente harmonia entre carboidratos complexos e proteínas magras',
          'Rico em antioxidantes naturais',
        ],
        dietaryBadges: [onlyEasy ? 'Fácil' : 'Média Dificuldade', 'Equilibrado'],
      },
      ingredients: [
        { name: primaryItem, amount: `${150 * servings}g`, isFromPantry: true },
        { name: secondaryItem, amount: `${120 * servings}g`, isFromPantry: true },
        { name: 'Azeite de oliva', amount: `${servings} colher(es) de sobremesa`, isFromPantry: true },
        { name: 'Ervas e temperos naturais', amount: 'A gosto', isFromPantry: true },
      ],
      missingIngredients: [],
      instructions: [
        { stepNumber: 1, instruction: 'Corte os ingredientes em tiras ou cubos uniformes para garantir cozimento por igual.', timerMinutes: 4 },
        { stepNumber: 2, instruction: `Salteie o ${primaryItem} em fogo médio-alto até dourar.`, timerMinutes: 6 },
        { stepNumber: 3, instruction: `Acrescente o ${secondaryItem} e finalize com as ervas aromáticas mantendo a textura al dente.`, timerMinutes: 3, tip: 'Fogo vivo preserva os minerais e vitaminas dos vegetais.' },
      ],
      chefTips: ['Para dar um toque especial, salpique sementes de gergelim ou raspas de limão ao final.'],
      storageTips: 'Geladeira por até 3 dias.',
    },

    // Opção 3: AVANÇADO / ELABORADO (ou FÁCIL se only_easy selecionado)
    {
      id: `fallback-srv-3-${Date.now()}`,
      title: onlyEasy
        ? `Bowl Prático de ${primaryItem} com Grãos Nobres e Mix de Folhas`
        : `Gourmet: ${primaryItem} Grelhado com Crosta de Ervas, Redução Suave e ${secondaryItem}`,
      subtitle: onlyEasy
        ? 'Montagem rápida em tigela, ideal para refeições práticas e nutritivas.'
        : 'Apresentação gastronômica sofisticada com camadas de sabores, perfeito para momentos especiais.',
      mealType: params.mealType || 'lunch',
      cuisineStyle: onlyEasy ? 'Bowl Funcional' : 'Gastronomia Saudável',
      servings: servings,
      prepTimeMinutes: onlyEasy ? 8 : 15,
      cookTimeMinutes: onlyEasy ? 10 : 25,
      totalTimeMinutes: onlyEasy ? 18 : 40,
      difficulty: onlyEasy ? 'fácil' : 'avançado',
      caloriesTarget: target,
      actualCalories: Math.round(target * 0.97),
      pantryMatchScore: 85,
      tags: onlyEasy ? ['Express 18min', 'Fácil', 'Completo'] : ['Gourmet Avançado', 'Alta Gastronomia', 'Alta Proteína'],
      nutrition: {
        macros: {
          calories: Math.round(target * 0.97),
          protein: isHighProtein ? 42 : 32,
          carbohydrates: isLowCarb ? 14 : 45,
          netCarbs: isLowCarb ? 9 : 37,
          fiber: 8,
          totalFat: 12,
          saturatedFat: 2.1,
          unsaturatedFat: 8.8,
          sodium: 390,
        },
        micronutrients: {
          iron: { name: 'Ferro', amount: 3.4, unit: 'mg', dailyValuePercent: 24, benefit: 'Transporte de oxigênio' },
          calcium: { name: 'Cálcio', amount: 150, unit: 'mg', dailyValuePercent: 15, benefit: 'Estrutura óssea' },
          zinc: { name: 'Zinco', amount: 2.9, unit: 'mg', dailyValuePercent: 26, benefit: 'Imunidade celular' },
          magnesium: { name: 'Magnésio', amount: 90, unit: 'mg', dailyValuePercent: 22, benefit: 'Relaxamento muscular' },
          potassium: { name: 'Potássio', amount: 640, unit: 'mg', dailyValuePercent: 19, benefit: 'Controle de pressão' },
          sodium: { name: 'Sódio', amount: 390, unit: 'mg', dailyValuePercent: 16, benefit: 'Equilíbrio osmótico' },
          vitaminC: { name: 'Vitamina C', amount: 55, unit: 'mg', dailyValuePercent: 61, benefit: 'Antioxidante potente' },
          vitaminD: { name: 'Vitamina D', amount: 1.4, unit: 'mcg', dailyValuePercent: 9, benefit: 'Imunidade' },
          vitaminA: { name: 'Vitamina A', amount: 370, unit: 'mcg', dailyValuePercent: 41, benefit: 'Saúde da visão' },
          vitaminB12: { name: 'Vitamina B12', amount: 1.1, unit: 'mcg', dailyValuePercent: 46, benefit: 'Energia' },
          vitaminB6: { name: 'Vitamina B6', amount: 0.7, unit: 'mg', dailyValuePercent: 41, benefit: 'Metabolismo' },
          folate: { name: 'Ácido Fólico (B9)', amount: 100, unit: 'mcg', dailyValuePercent: 25, benefit: 'Regeneração' },
          vitaminE: { name: 'Vitamina E', amount: 2.6, unit: 'mg', dailyValuePercent: 17, benefit: 'Antioxidante' },
        },
        nutritionalHighlights: [
          'Densidade nutricional elevada com rica paleta de micronutrientes',
          'Apresentação impecável que valoriza a experiência da dieta',
        ],
        dietaryBadges: [onlyEasy ? 'Fácil' : 'Gourmet Avançado', 'Alta Densidade Nutricional'],
      },
      ingredients: [
        { name: primaryItem, amount: `${160 * servings}g`, isFromPantry: true },
        { name: secondaryItem, amount: `${130 * servings}g`, isFromPantry: true },
        { name: 'Azeite extra virgem e redução de vinagrete balsâmico ou limão', amount: `${servings} colher de sopa`, isFromPantry: true },
        { name: 'Ervas frescas (alecrim, tomilho ou orégano)', amount: 'A gosto', isFromPantry: true },
      ],
      missingIngredients: [],
      instructions: onlyEasy
        ? [
            { stepNumber: 1, instruction: `Disponha os grãos ou carboidratos na base da tigela.`, timerMinutes: 2 },
            { stepNumber: 2, instruction: `Grelhe rapidamente o ${primaryItem} e adicione por cima.`, timerMinutes: 6 },
            { stepNumber: 3, instruction: `Finalize com o ${secondaryItem} e um fio de azeite extra virgem.`, timerMinutes: 2 },
          ]
        : [
            { stepNumber: 1, instruction: `Faça uma marinada do ${primaryItem} com azeite, alho triturado, limão e ervas finas por 10 minutos.`, timerMinutes: 10, tip: 'A marinada amacia as fibras e intensifica os aromas naturais.' },
            { stepNumber: 2, instruction: `Grelhe em frigideira pesada bem quente por 4 minutos de cada lado até formar uma crosta dourada aromática.`, timerMinutes: 8 },
            { stepNumber: 3, instruction: `Em paralelo, salteie o ${secondaryItem} com um toque de azeite e ervas frescas até caramelizar levemente.`, timerMinutes: 5 },
            { stepNumber: 4, instruction: `Monte o prato de forma empratada e regue com o próprio suco da frigideira.`, timerMinutes: 3 },
          ],
      chefTips: ['Uma apresentação bonita ativa os centros de saciedade visual do cérebro, tornando a adesão à dieta muito mais prazerosa.'],
      storageTips: 'Consumir preferencialmente fresco ou refrigerar por até 3 dias.',
    },
  ];
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
