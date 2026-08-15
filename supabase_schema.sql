-- =========================================================================
-- BANCO DE DADOS: APLICATIVO NUTRICIONISTA WAGNER TORRES
-- Tabela de Pacientes & Painel Administrativo do Nutricionista
-- =========================================================================

-- 1. Criação / Atualização da tabela de pacientes
CREATE TABLE IF NOT EXISTS public.patients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cpf TEXT UNIQUE NOT NULL,
  birth_date TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT DEFAULT 'patient', -- 'nutritionist' ou 'patient'
  target_calories INTEGER DEFAULT 500,
  diet_goal TEXT DEFAULT 'high_protein',
  status TEXT DEFAULT 'active', -- 'active' ou 'inactive'
  plan_expiration_date DATE, -- Data de vencimento do plano
  plan_data JSONB, -- JSON completo do plano alimentar importado do GetNutri
  water_meta INTEGER DEFAULT 2500,
  goals JSONB,
  guidelines JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Se a tabela já existir, adiciona as colunas novas caso não existam:
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'patient';
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS plan_expiration_date DATE;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS plan_data JSONB;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS water_meta INTEGER DEFAULT 2500;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS goals JSONB;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS guidelines JSONB;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now());

-- 2. Habilitação de segurança (Row Level Security)
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Permitir leitura para login de pacientes" ON public.patients;
CREATE POLICY "Permitir leitura para login de pacientes"
  ON public.patients FOR SELECT USING (true);

DROP POLICY IF EXISTS "Permitir cadastro de novos pacientes" ON public.patients;
CREATE POLICY "Permitir cadastro de novos pacientes"
  ON public.patients FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir atualizacao de pacientes" ON public.patients;
CREATE POLICY "Permitir atualizacao de pacientes"
  ON public.patients FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Permitir exclusao de pacientes" ON public.patients;
CREATE POLICY "Permitir exclusao de pacientes"
  ON public.patients FOR DELETE USING (true);

-- 3. Cadastrar / Garantir o Perfil Mestre do Nutricionista Wagner Torres
-- Substitua '00000000000' e '01011985' pelo seu CPF e Data de Nascimento reais se preferir:
INSERT INTO public.patients (cpf, birth_date, full_name, role, status)
VALUES ('00000000000', '01011985', 'Nutricionista Wagner Torres', 'nutritionist', 'active')
ON CONFLICT (cpf) DO UPDATE SET role = 'nutritionist';
