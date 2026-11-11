-- Category icons (#423): an emoji each, as Monarch has. The default categories come with one.
-- Existing households' categories get one when their name is a default's or one of Monarch's (for
-- households that came from it), whatever the case; the rest stay without until someone picks one.
CREATE FUNCTION fiscus_default_category_icon(p_name text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
  AS $$
SELECT CASE lower(btrim(p_name))
  WHEN 'paychecks' THEN '💰'
  WHEN 'interest' THEN '📈'
  WHEN 'other income' THEN '💵'
  WHEN 'rent or mortgage' THEN '🏠'
  WHEN 'utilities' THEN '💡'
  WHEN 'internet and phone' THEN '📱'
  WHEN 'home insurance' THEN '🛡️'
  WHEN 'home maintenance' THEN '🔧'
  WHEN 'groceries' THEN '🛒'
  WHEN 'restaurants' THEN '🍽️'
  WHEN 'coffee' THEN '☕'
  WHEN 'gas' THEN '⛽'
  WHEN 'public transit' THEN '🚇'
  WHEN 'parking and tolls' THEN '🅿️'
  WHEN 'car maintenance' THEN '🚗'
  WHEN 'car insurance' THEN '🚙'
  WHEN 'clothing' THEN '👕'
  WHEN 'household supplies' THEN '🧴'
  WHEN 'electronics' THEN '💻'
  WHEN 'medical' THEN '🩺'
  WHEN 'pharmacy' THEN '💊'
  WHEN 'fitness' THEN '🏋️'
  WHEN 'entertainment' THEN '🎬'
  WHEN 'subscriptions' THEN '🔁'
  WHEN 'hobbies' THEN '🎨'
  WHEN 'flights' THEN '✈️'
  WHEN 'lodging' THEN '🏨'
  WHEN 'travel other' THEN '🧳'
  WHEN 'childcare' THEN '🧸'
  WHEN 'kids' THEN '🧒'
  WHEN 'pets' THEN '🐾'
  WHEN 'gifts' THEN '🎁'
  WHEN 'charity' THEN '🤝'
  WHEN 'loan payments' THEN '🏦'
  WHEN 'fees' THEN '🧾'
  WHEN 'taxes' THEN '🏛️'
  WHEN 'savings transfers' THEN '🐷'
  WHEN 'investments' THEN '📊'
  WHEN 'transfer' THEN '🔄'
  WHEN 'settlement' THEN '⚖️'
  WHEN 'uncategorized' THEN '❔'
  WHEN 'miscellaneous' THEN '📦'
  WHEN 'business income' THEN '💼'
  WHEN 'bonus' THEN '🎉'
  WHEN 'pretax paycheck' THEN '💰'
  WHEN 'dividends & capital gains' THEN '📈'
  WHEN 'cash back' THEN '💸'
  WHEN 'auto payment' THEN '🚗'
  WHEN 'auto maintenance' THEN '🔧'
  WHEN 'parking & tolls' THEN '🅿️'
  WHEN 'taxi & ride shares' THEN '🚕'
  WHEN 'mortgage' THEN '🏠'
  WHEN 'rent' THEN '🏠'
  WHEN 'home improvement' THEN '🔨'
  WHEN 'garbage' THEN '🗑️'
  WHEN 'water' THEN '💧'
  WHEN 'gas & electric' THEN '💡'
  WHEN 'internet & cable' THEN '🌐'
  WHEN 'phone' THEN '📱'
  WHEN 'restaurants & bars' THEN '🍽️'
  WHEN 'coffee shops' THEN '☕'
  WHEN 'bars' THEN '🍸'
  WHEN 'take-out / fast food' THEN '🍔'
  WHEN 'travel & vacation' THEN '🏖️'
  WHEN 'entertainment & recreation' THEN '🎬'
  WHEN 'personal' THEN '🙂'
  WHEN 'fun money' THEN '🎉'
  WHEN 'shopping' THEN '🛍️'
  WHEN 'furniture & housewares' THEN '🛋️'
  WHEN 'child care' THEN '🧸'
  WHEN 'child activities' THEN '⚽'
  WHEN 'student loans' THEN '🎓'
  WHEN 'education' THEN '🎓'
  WHEN 'dentist' THEN '🦷'
  WHEN 'gym' THEN '🏋️'
  WHEN 'garden' THEN '🌱'
  WHEN 'loan repayment' THEN '🏦'
  WHEN 'financial & legal services' THEN '⚖️'
  WHEN 'financial fees' THEN '🧾'
  WHEN 'cash & atm' THEN '🏧'
  WHEN 'insurance' THEN '🛡️'
  WHEN 'check' THEN '📝'
  WHEN 'credit card payment' THEN '💳'
  WHEN 'balance adjustments' THEN '🧮'
  WHEN 'buy' THEN '🛒'
  WHEN 'sell' THEN '💱'
  WHEN 'advertising & promotion' THEN '📣'
  WHEN 'business utilities & communication' THEN '📞'
  WHEN 'employee wages & contract labor' THEN '👷'
  WHEN 'business travel & meals' THEN '🧳'
  WHEN 'business auto expenses' THEN '🚗'
  WHEN 'business insurance' THEN '🛡️'
  WHEN 'office supplies & expenses' THEN '🖇️'
  WHEN 'office rent' THEN '🏢'
  WHEN 'postage & shipping' THEN '📮'
  WHEN 'business service' THEN '💼'
  WHEN 'website expenses' THEN '🌐'
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fiscus_seed_default_categories(p_household uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
DECLARE
  g record;
  v_group uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM category_groups WHERE household_id = p_household) THEN
    RETURN;
  END IF;
  FOR g IN
    SELECT * FROM (VALUES
      (1, 'Income', 'income', ARRAY['Paychecks', 'Interest', 'Other income'], ARRAY[NULL, NULL, NULL]::text[]),
      (2, 'Home', 'fixed', ARRAY['Rent or mortgage', 'Utilities', 'Internet and phone', 'Home insurance', 'Home maintenance'], ARRAY[NULL, NULL, NULL, NULL, NULL]::text[]),
      (3, 'Food', 'flexible', ARRAY['Groceries', 'Restaurants', 'Coffee'], ARRAY[NULL, NULL, NULL]::text[]),
      (4, 'Transportation', 'flexible', ARRAY['Gas', 'Public transit', 'Parking and tolls', 'Car maintenance', 'Car insurance'], ARRAY[NULL, NULL, NULL, NULL, NULL]::text[]),
      (5, 'Shopping', 'flexible', ARRAY['Clothing', 'Household supplies', 'Electronics'], ARRAY[NULL, NULL, NULL]::text[]),
      (6, 'Health', 'flexible', ARRAY['Medical', 'Pharmacy', 'Fitness'], ARRAY[NULL, NULL, NULL]::text[]),
      (7, 'Fun', 'flexible', ARRAY['Entertainment', 'Subscriptions', 'Hobbies'], ARRAY[NULL, NULL, NULL]::text[]),
      (8, 'Travel', 'non_monthly', ARRAY['Flights', 'Lodging', 'Travel other'], ARRAY[NULL, NULL, NULL]::text[]),
      (9, 'Family and pets', 'flexible', ARRAY['Childcare', 'Kids', 'Pets'], ARRAY[NULL, NULL, NULL]::text[]),
      (10, 'Gifts and giving', 'non_monthly', ARRAY['Gifts', 'Charity'], ARRAY[NULL, NULL]::text[]),
      (11, 'Financial', 'fixed', ARRAY['Loan payments', 'Fees', 'Taxes'], ARRAY[NULL, NULL, NULL]::text[]),
      (12, 'Savings', 'savings', ARRAY['Savings transfers', 'Investments'], ARRAY[NULL, NULL]::text[]),
      (13, 'Transfers', 'transfer', ARRAY['Transfer', 'Settlement'], ARRAY['transfer', 'settlement']::text[]),
      (14, 'Other', 'flexible', ARRAY['Uncategorized', 'Miscellaneous'], ARRAY['uncategorized', NULL]::text[])
    ) AS v(ord, name, kind, names, keys)
    ORDER BY ord
  LOOP
    v_group := uuidv7();
    INSERT INTO category_groups (id, household_id, name, kind, sort_order)
      VALUES (v_group, p_household, g.name, g.kind::category_kind, g.ord);
    INSERT INTO categories (id, household_id, group_id, name, icon, system_key, sort_order)
      SELECT uuidv7(), p_household, v_group, n.name, fiscus_default_category_icon(n.name),
        g.keys[n.i], n.i
      FROM unnest(g.names) WITH ORDINALITY AS n(name, i);
  END LOOP;
END
$$;
--> statement-breakpoint
UPDATE categories SET icon = fiscus_default_category_icon(name)
WHERE icon IS NULL AND fiscus_default_category_icon(name) IS NOT NULL;
