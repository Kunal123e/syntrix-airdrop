// =========================================================================
// SYNTRIX XP & PROGRESSION ENGINE (ISOLATED MODULE)
// =========================================================================

const RANKS = [
  { level: 1, rank: 'Explorer', xpRequired: 0 },
  { level: 2, rank: 'Contributor', xpRequired: 200 },
  { level: 3, rank: 'Analyst', xpRequired: 500 },
  { level: 4, rank: 'Verifier', xpRequired: 900 },
  { level: 5, rank: 'Researcher', xpRequired: 1500 },
  { level: 6, rank: 'Specialist', xpRequired: 2300 },
  { level: 7, rank: 'Strategist', xpRequired: 3300 },
  { level: 8, rank: 'Expert', xpRequired: 4600 },
  { level: 9, rank: 'Innovator', xpRequired: 6200 },
  { level: 10, rank: 'AI Pioneer', xpRequired: 8000 }
];

// 🚀 NEW: CORE ECONOMIC MULTIPLIER ALGORITHM
function getLevelMultiplier(level) {
  if (level >= 10) return 2.25;
  if (level === 9)  return 2.10;
  if (level === 8)  return 1.95;
  if (level === 7)  return 1.80;
  if (level === 6)  return 1.65;
  if (level === 5)  return 1.50; // Milestone!
  if (level === 4)  return 1.35;
  if (level === 3)  return 1.20;
  if (level === 2)  return 1.10;
  return 1.00; // Level 1 Baseline
}

// 🚀 NEW: TASK PAYOUT CRUNCHER
function calculateFinalTaskReward(baseAmount, level, streakDays) {
  const levelMult = getLevelMultiplier(level);
  
  // Cap streak bonus at 20% (10 consecutive days)
  const streakBonus = Math.min(0.20, (streakDays || 0) * 0.02);
  const totalMult = levelMult * (1 + streakBonus);
  
  // Round to exactly 2 decimal places for financial accuracy
  const finalReward = Math.round((baseAmount * totalMult) * 100) / 100;

  return {
    baseAmount,
    finalReward,
    levelMult,
    streakBonusPercent: Math.round(streakBonus * 100),
    totalMultiplier: Math.round(totalMult * 100) / 100
  };
}

function calculateLevelAndRank(totalXP) {
  let level = 1;
  let rank = 'Explorer';
  let currentLevelStartXP = 0;
  let nextLevelXP = 200;

  if (totalXP >= 8000) {
    // Levels 10+ smooth linear scaling (+2000 XP per level)
    const extraXP = totalXP - 8000;
    const extraLevels = Math.floor(extraXP / 2000);
    level = 10 + extraLevels;
    rank = 'AI Pioneer';
    currentLevelStartXP = 8000 + (extraLevels * 2000);
    nextLevelXP = currentLevelStartXP + 2000;
  } else {
    for (let i = RANKS.length - 1; i >= 0; i--) {
      if (totalXP >= RANKS[i].xpRequired) {
        level = RANKS[i].level;
        rank = RANKS[i].rank;
        currentLevelStartXP = RANKS[i].xpRequired;
        nextLevelXP = RANKS[i + 1] ? RANKS[i + 1].xpRequired : 8000;
        break;
      }
    }
  }

  return { level, rank, currentLevelStartXP, nextLevelXP };
}

async function awardXP(supabase, email, amount, reason, category = null) {
  if (!email || amount <= 0) return;
  const sanitizedEmail = email.trim().toLowerCase();

  try {
    // 1. Fetch or auto-create profile
    let { data: profile } = await supabase
      .from('syntrix_xp_profile')
      .select('*')
      .eq('email', sanitizedEmail)
      .maybeSingle();

    if (!profile) {
      const { data: inserted } = await supabase
        .from('syntrix_xp_profile')
        .insert([{
          email: sanitizedEmail,
          total_xp: 0,
          current_level: 1,
          current_rank: 'Explorer',
          highest_level: 1,
          daily_streak: 0,
          last_login_date: null
        }])
        .select('*')
        .single();
      profile = inserted;
    }

    // 2. Anti-Exploit Check: Prevent duplicate Survey XP
    if (category === 'survey') {
      const { data: existing } = await supabase
        .from('syntrix_xp_history')
        .select('id')
        .eq('email', sanitizedEmail)
        .eq('reason', reason)
        .maybeSingle();

      if (existing) {
        console.log(`[XP ENGINE] ${sanitizedEmail} already received XP for '${reason}'. Skipping.`);
        return;
      }
    }

    // 🚀 3. EXACT DAILY STREAK CALCULATION LOGIC
    let daily_streak = profile.daily_streak || 0;
    let last_login_date = profile.last_login_date || null;
    
    // Use strict UTC date to avoid local timezone abuse
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    if (category === 'login') {
        if (last_login_date === today) {
            console.log(`[XP ENGINE] ${sanitizedEmail} already claimed daily login today. Streak preserved.`);
            return; // Exit silently, they already got their login XP today
        }
        
        const yesterdayDate = new Date(now);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const yesterday = yesterdayDate.toISOString().split('T')[0];

        if (last_login_date === yesterday) {
            daily_streak += 1; // Streak preserved and increased!
        } else {
            daily_streak = 1; // Streak broken, reset back to Day 1
        }
        last_login_date = today;
    }

    // 4. Calculate new level metrics
    const newTotalXP = (profile.total_xp || 0) + amount;
    const { level, rank } = calculateLevelAndRank(newTotalXP);

    const updates = {
      total_xp: newTotalXP,
      current_level: level,
      current_rank: rank,
      highest_level: Math.max(profile.highest_level || 1, level),
      daily_streak: daily_streak,
      last_login_date: last_login_date !== null ? last_login_date : profile.last_login_date,
      updated_at: new Date().toISOString()
    };

    if (category === 'survey') updates.survey_count = (profile.survey_count || 0) + 1;
    if (category === 'document') updates.document_count = (profile.document_count || 0) + 1;
    if (category === 'selfie') updates.selfie_count = (profile.selfie_count || 0) + 1;
    if (category === 'referral') updates.referral_count = (profile.referral_count || 0) + 1;

    // 5. Update Profile & Append History Ledger
    await supabase.from('syntrix_xp_profile').update(updates).eq('email', sanitizedEmail);
    await supabase.from('syntrix_xp_history').insert([{
      email: sanitizedEmail,
      amount: amount,
      reason: reason
    }]);

    console.log(`[XP ENGINE] +${amount} XP -> ${sanitizedEmail} ('${reason}'). Level: ${level}, Streak: ${daily_streak}`);

  } catch (err) {
    console.error('[XP ENGINE ERROR]:', err.message);
  }
}

async function getXPProfile(supabase, email) {
  if (!email) return null;
  const sanitizedEmail = email.trim().toLowerCase();

  let { data: profile } = await supabase
    .from('syntrix_xp_profile')
    .select('*')
    .eq('email', sanitizedEmail)
    .maybeSingle();

  if (!profile) {
    return {
      totalXP: 0,
      currentLevel: 1,
      currentRank: 'Explorer',
      xpCurrentLevel: 0,
      xpRequiredNextLevel: 200,
      levelProgressPercentage: 0,
      highestLevel: 1,
      dailyStreak: 0,
      multiplier: 1.0,
      streakBonusPercent: 0,
      totalMultiplier: 1.0,
      recentHistory: []
    };
  }

  const { level, rank, currentLevelStartXP, nextLevelXP } = calculateLevelAndRank(profile.total_xp);
  const xpInCurrentLevel = profile.total_xp - currentLevelStartXP;
  const xpNeededForLevel = nextLevelXP - currentLevelStartXP;
  const progressPercentage = Math.min(100, Math.round((xpInCurrentLevel / xpNeededForLevel) * 100));

  const { data: history } = await supabase
    .from('syntrix_xp_history')
    .select('amount, reason, created_at')
    .eq('email', sanitizedEmail)
    .order('created_at', { ascending: false })
    .limit(5);

  // 🚀 Expose financial multiplier stats to the UI
  const rewardStats = calculateFinalTaskReward(48, level, profile.daily_streak);

  return {
    totalXP: profile.total_xp,
    currentLevel: level,
    currentRank: rank,
    xpCurrentLevel: profile.total_xp,
    currentLevelStartXP,
    xpRequiredNextLevel: nextLevelXP,
    xpRemaining: nextLevelXP - profile.total_xp,
    levelProgressPercentage: progressPercentage,
    highestLevel: profile.highest_level,
    dailyStreak: profile.daily_streak || 0,
    surveyCount: profile.survey_count || 0,
    documentCount: profile.document_count || 0,
    selfieCount: profile.selfie_count || 0,
    referralCount: profile.referral_count || 0,
    multiplier: rewardStats.levelMult,
    streakBonusPercent: rewardStats.streakBonusPercent,
    totalMultiplier: rewardStats.totalMultiplier,
    recentHistory: history || []
  };
}

module.exports = {
  awardXP,
  getXPProfile,
  calculateFinalTaskReward
};
