const { expect } = require("chai");
const {
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  amountFunction,
  grantComponentRole,
  grantRole,
  getTransactionEvent,
  addEToken,
} = require("@ensuro/core/js/test-utils");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("Test AAVE asset manager - run at https://polygonscan.com/block/33313517", function () {
  let currency;
  let pool;
  let owner, lp, lp2, guardian, admin;
  const _A = amountFunction(6);
  let jrEtk, srEtk;
  let accessManager;
  const CENTS = _A(0.001);

  const ADDRESSES = {
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    aave: "0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf",
    aaveV3: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    usrUSDC: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045", // Random account with lot of USDC
    amUSDC: "0x1a13F4Ca1d028320A707D99520AbFefca3998b7F",
    amUSDCv3: "0x625E7708f30cA75bfd92586e17077590C60eb4cD",

    wmatic: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    weth: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    ensuroTreasury: "0x913B9dff6D780cF4cda0b0321654D7261d5593d0",  // Random address
    etk: "0xCFfDcC8e99Aa22961704b9C7b67Ed08A66EA45Da",
    variableDebtmUSDC: "0x248960A9d75EdFa3de94F7193eae3161Eb349a12",
    oracle: "0x0229f777b0fab107f9591a41d5f02e4e98db6f2d",  // AAVE PriceOracle
    sushi: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",  // Sushiswap router
    assetMgr: "0x09d9Dd252659a497F3525F257e204E7192beF132",
    usrWMATIC: "0x55FF76BFFC3Cdd9D5FdbBC2ece4528ECcE45047e", // Random account with log of WMATIC
  };

  beforeEach(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ALCHEMY_URL,
            blockNumber: 33313517,
          },
        },
      ],
    });
    [owner, lp2, guardian, admin] = await ethers.getSigners();
    await helpers.impersonateAccount(ADDRESSES.usrUSDC);
    await helpers.setBalance(ADDRESSES.usrUSDC, 100n ** 18n);
    lp = await ethers.getSigner(ADDRESSES.usrUSDC);


    pool = await deployPool(hre, {
      currency: ADDRESSES.usdc,
      grantRoles: [],
      treasuryAddress: "0x12345678901234567890123456789061c9177f41",
    });
    pool._A = _A;

    currency = await ethers.getContractAt("IERC20Metadata", ADDRESSES.usdc);

    srEtk = await addEToken(pool, {});
    jrEtk = await addEToken(pool, {});

    await deployPremiumsAccount(hre, pool, {
      jrEtkAddr: jrEtk.address,
      srEtkAddr: srEtk.address,
    });
    accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", guardian.address);
    await grantRole(hre, accessManager, "LEVEL1_ROLE", admin.address);

    // Grant roles to set parameters
    await grantComponentRole(hre, accessManager, jrEtk, "LEVEL2_ROLE", admin.address);
    await grantComponentRole(hre, accessManager, srEtk, "LEVEL2_ROLE", admin.address);

    await currency.connect(lp).approve(pool.address, _A(100000));
  });

  const testAMFlow = async function (amContract, aaveAddress, aToken) {
    await pool.connect(lp).deposit(jrEtk.address, _A(10000));
    const am = await amContract.deploy(ADDRESSES.usdc, aaveAddress);
    expect(await am.getInvestmentValue()).to.be.equal(_A(0)); // Implementation balance is 0

    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(10000));

    await jrEtk.connect(admin).setAssetManager(am.address, false);

    await jrEtk.connect(admin).forwardToAssetManager(
      amContract.interface.encodeFunctionData(
        "setLiquidityThresholds", [_A(1000), _A(2000), _A(3000)]
      )
    );

    let tx = await jrEtk.checkpoint();
    let receipt = await tx.wait();
    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(2000));
    expect(await aToken.balanceOf(jrEtk.address)).to.be.equal(_A(8000));
    evt = getTransactionEvent(am.interface, receipt, "MoneyInvested");
    expect(evt.args.amount).to.be.equal(_A(8000));

    // After some time, earnings generated and distributed
    await helpers.time.increase(3600*24*365);
    const newBalance = await aToken.balanceOf(jrEtk.address);
    expect(newBalance).to.be.gt(_A(8000));  // Yields produced by AAVE's interest rate
    tx = await jrEtk.recordEarnings();
    receipt = await tx.wait();
    evt = getTransactionEvent(am.interface, receipt, "EarningsRecorded");
    expect(evt.args.earnings).to.be.closeTo(newBalance - _A(8000), CENTS);
    expect(await jrEtk.balanceOf(lp.address)).to.closeTo(newBalance.add(_A(2000)), CENTS);

    // Withdrawal more than ETK liquidity requires deinvestment
    tx = await pool.connect(lp).withdraw(jrEtk.address, _A(3000));
    receipt = await tx.wait();
    evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
    expect(evt.args.amount).to.be.equal(_A(3000));
    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(2000)); // jrEtk stays at middle
    expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(newBalance - _A(3000), CENTS);

    // Withdrawal less than ETK liquidity doesn't
    tx = await pool.connect(lp).withdraw(jrEtk.address, _A(1500));
    receipt = await tx.wait();
    evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
    expect(evt).to.be.equal(null);
    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(500));
    expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(newBalance - _A(3000), CENTS);

    // Rebalance refills ETK liquidity
    tx = await jrEtk.rebalance();
    receipt = await tx.wait();
    evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
    expect(evt.args.amount).to.be.equal(_A(1500));
    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(2000)); // jrEtk back at middle
    expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(newBalance - _A(4500), CENTS);

    // Setting AM to zero deinvests all
    const preBalance = await aToken.balanceOf(jrEtk.address);
    await helpers.time.increase(3600*24*90);
    const postBalance = await aToken.balanceOf(jrEtk.address);
    expect(postBalance).to.be.gt(preBalance); // some returns
    tx = await jrEtk.connect(admin).setAssetManager(ethers.constants.AddressZero, false);
    receipt = await tx.wait();
    expect(await aToken.balanceOf(jrEtk.address)).to.be.equal(0);
    expect(await currency.balanceOf(jrEtk.address)).to.be.closeTo(
      _A(2000).add(postBalance), CENTS
    );
    evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
    expect(evt.args.amount).to.be.closeTo(postBalance, CENTS);
    evt = getTransactionEvent(am.interface, receipt, "EarningsRecorded");
    expect(evt.args.earnings).to.be.closeTo(postBalance.sub(preBalance), CENTS);
  };

  const testSharedAm = async function (amContract, aaveAddress, aToken) {
    await pool.connect(lp).deposit(jrEtk.address, _A(10000));
    await currency.connect(lp).transfer(lp2.address, _A(5000)); // give some money to my friend lp2
    await currency.connect(lp2).approve(pool.address, ethers.constants.MaxUint256);
    await pool.connect(lp2).deposit(srEtk.address, _A(5000));

    const am = await amContract.deploy(ADDRESSES.usdc, aaveAddress);

    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(10000));
    expect(await currency.balanceOf(srEtk.address)).to.be.equal(_A(5000));

    await jrEtk.connect(admin).setAssetManager(am.address, false);
    await srEtk.connect(guardian).setAssetManager(am.address, false);

    await jrEtk.connect(admin).forwardToAssetManager(
      amContract.interface.encodeFunctionData(
        "setLiquidityThresholds", [_A(1000), _A(2000), _A(3000)]
      )
    );

    await srEtk.connect(admin).forwardToAssetManager(
      amContract.interface.encodeFunctionData(
        "setLiquidityThresholds", [_A(500), _A(1000), _A(1500)]
      )
    );

    await jrEtk.checkpoint();
    await srEtk.checkpoint();
    expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(_A(8000), CENTS);
    expect(await aToken.balanceOf(srEtk.address)).to.be.closeTo(_A(4000), CENTS);
  };

  it("Creates an asset manager and invests in AAVE-v2", async function () {
    const AAVEv2AssetManager = await ethers.getContractFactory("AAVEv2AssetManager");
    const aToken = await ethers.getContractAt("IERC20Metadata", ADDRESSES.amUSDC);
    await testAMFlow(AAVEv2AssetManager, ADDRESSES.aave, aToken);
  });

  it("The same AM contract can be shared between reserves - just shares code - AAVE-v2", async function () {
    const AAVEv2AssetManager = await ethers.getContractFactory("AAVEv2AssetManager");
    const aToken = await ethers.getContractAt("IERC20Metadata", ADDRESSES.amUSDC);
    await testSharedAm(AAVEv2AssetManager, ADDRESSES.aave, aToken);
  });

  it("Creates an asset manager and invests in AAVE-v3", async function () {
    const AAVEv3AssetManager = await ethers.getContractFactory("AAVEv3AssetManager");
    const aToken = await ethers.getContractAt("IERC20Metadata", ADDRESSES.amUSDCv3);
    await testAMFlow(AAVEv3AssetManager, ADDRESSES.aaveV3, aToken);
  });

  it("The same AM contract can be shared between reserves - just shares code - AAVE-v3", async function () {
    const AAVEv3AssetManager = await ethers.getContractFactory("AAVEv3AssetManager");
    const aToken = await ethers.getContractAt("IERC20Metadata", ADDRESSES.amUSDCv3);
    await testSharedAm(AAVEv3AssetManager, ADDRESSES.aaveV3, aToken);
  });
});
